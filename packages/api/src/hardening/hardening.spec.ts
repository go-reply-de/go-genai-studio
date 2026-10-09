import http from 'http';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, logger } from '@librechat/data-schemas';
import type { IRole } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { HardeningMethods } from './start';
import type { CappedRole } from './caps';
import {
  createStrictBrowserEgress,
  STRICT_EGRESS_POLICY,
  STRICT_PERMISSIONS_POLICY,
} from './egress';
import { applyRolePermissionCaps, parseRolePermissionCaps } from './caps';
import { createStartupConfigFlags } from './config';
import { createSpeechAccessGate } from './speech';
import { startHardening } from './start';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const originalEnv = { ...process.env };
const CAPS = 'USER.AGENTS.CREATE,USER.AGENTS.SHARE,USER.AGENTS.SHARE_PUBLIC,USER.PROMPTS.CREATE';

afterEach(() => {
  process.env = { ...originalEnv };
  jest.clearAllMocks();
});

/** Raw header lines, so two policies are seen as two headers rather than one merged value. */
async function rawHeaders(app: express.Express, route: string): Promise<string[]> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string[]>((resolve, reject) => {
      http
        .get({ port, path: route }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.rawHeaders));
        })
        .on('error', reject);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function headerValues(raw: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === name.toLowerCase()) {
      values.push(raw[i + 1]);
    }
  }
  return values;
}

/** Routes standing in for the app's own config and speech routers. */
function mountAppRoutes(app: express.Express): void {
  app.get('/api/config', (_req, res) => {
    res.status(200).send({ appTitle: 'Synthetic' });
  });
  app.post('/api/files/speech/stt', (_req, res) => {
    res.status(200).json({ text: 'synthetic' });
  });
  app.post('/api/files/speech/tts/manual', (_req, res) => {
    res.status(200).end();
  });
  app.get('/api/files/speech/config/get', (_req, res) => {
    res.status(200).json({ speechTab: {} });
  });
}

describe('parseRolePermissionCaps', () => {
  it('groups known bits by role and ignores the rest with a warning', () => {
    const caps = parseRolePermissionCaps(
      `${CAPS}, USER.AGENTS.FLY,USER.NOPE.CREATE,USER.AGENTS,ADMIN.PROMPTS.SHARE.EXTRA`,
    );

    expect([...caps.entries()]).toEqual([
      [
        'USER',
        {
          AGENTS: { CREATE: false, SHARE: false, SHARE_PUBLIC: false },
          PROMPTS: { CREATE: false },
        },
      ],
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });
});

describe('applyRolePermissionCaps', () => {
  let mongoServer: MongoMemoryServer;
  let methods: ReturnType<typeof createMethods>;
  const cache = new Map<string, unknown>();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    methods = createMethods(mongoose, {
      getCache: () => ({
        get: async (key: string) => cache.get(key),
        set: async (key: string, value: unknown) => cache.set(key, value),
      }),
    });
  }, DB_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  }, DB_SETUP_TIMEOUT_MS);

  beforeEach(async () => {
    cache.clear();
    await mongoose.models.Role.deleteMany({});
    await methods.initializeRoles();
    cache.clear();
  });

  const storedBits = async (type: string): Promise<Record<string, boolean | undefined>> => {
    const [role] = (await methods.findRolesByNames(['USER'])) as CappedRole[];
    return role?.permissions?.[type] ?? {};
  };

  it('lowers the listed bits in the record and the role cache, leaving the rest alone', async () => {
    await methods.updateAccessPermissions('USER', {
      AGENTS: { USE: true, CREATE: true, SHARE: true },
      PROMPTS: { USE: true, CREATE: true },
    });

    await applyRolePermissionCaps(methods, { ROLE_PERMISSION_CAPS: CAPS });

    expect(await storedBits('AGENTS')).toMatchObject({
      USE: true,
      CREATE: false,
      SHARE: false,
      SHARE_PUBLIC: false,
    });
    expect(await storedBits('PROMPTS')).toMatchObject({ USE: true, CREATE: false });
    const cached = cache.get('USER') as CappedRole;
    expect(cached.permissions?.AGENTS).toMatchObject({ CREATE: false, SHARE: false });
  });

  it('refreshes a stale cached role even when the record is already capped', async () => {
    await applyRolePermissionCaps(methods, { ROLE_PERMISSION_CAPS: CAPS });
    const [stored] = (await methods.findRolesByNames(['USER'])) as CappedRole[];
    cache.set('USER', {
      ...stored,
      permissions: { ...stored.permissions, AGENTS: { USE: true, CREATE: true } },
    });

    await applyRolePermissionCaps(methods, { ROLE_PERMISSION_CAPS: CAPS });

    expect((cache.get('USER') as CappedRole).permissions?.AGENTS).toMatchObject({
      CREATE: false,
    });
  });

  it('never raises a bit and reads nothing without ROLE_PERMISSION_CAPS', async () => {
    const tracked: HardeningMethods<IRole> = {
      findRolesByNames: jest.fn(methods.findRolesByNames),
      getRoleByName: jest.fn(methods.getRoleByName),
      updateAccessPermissions: jest.fn(methods.updateAccessPermissions),
      updateRoleByName: jest.fn(methods.updateRoleByName),
      getFiles: jest.fn(),
    };

    await applyRolePermissionCaps(tracked, {});
    expect(tracked.findRolesByNames).not.toHaveBeenCalled();

    await applyRolePermissionCaps(tracked, {
      ROLE_PERMISSION_CAPS: 'USER.AGENTS.USE,GHOST.AGENTS.CREATE',
    });
    expect(await storedBits('AGENTS')).toMatchObject({ USE: false });
    expect(tracked.updateAccessPermissions).toHaveBeenCalledWith(
      'USER',
      { AGENTS: { USE: false } },
      expect.anything(),
    );
    expect(await methods.findRolesByNames(['GHOST'])).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"GHOST" not found'));
  });
});

describe('createStrictBrowserEgress', () => {
  it('adds its own policy next to one a handler sets later, and the permissions policy', async () => {
    const app = express();
    app.use(createStrictBrowserEgress());
    app.get('/shell', (_req, res) => {
      res.set('Content-Security-Policy', "default-src 'self'");
      res.send('<html></html>');
    });
    app.get('/stream', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: synthetic\n\n');
    });

    const shell = await rawHeaders(app, '/shell');
    expect(headerValues(shell, 'Content-Security-Policy')).toEqual([
      "default-src 'self'",
      STRICT_EGRESS_POLICY,
    ]);
    expect(headerValues(shell, 'Permissions-Policy')).toEqual([STRICT_PERMISSIONS_POLICY]);
    expect(headerValues(await rawHeaders(app, '/stream'), 'Content-Security-Policy')).toEqual([
      STRICT_EGRESS_POLICY,
    ]);
    expect(STRICT_EGRESS_POLICY).toContain("img-src 'self' data: blob:");
    expect(STRICT_EGRESS_POLICY).toContain("connect-src 'self'");
  });
});

describe('createSpeechAccessGate and createStartupConfigFlags', () => {
  it('refuses server speech, keeps the speech config readable and flags the startup config', async () => {
    const app = express();
    app.use('/api/files/speech', createSpeechAccessGate());
    app.use('/api/config', createStartupConfigFlags({ speechLocalOnly: true }));
    mountAppRoutes(app);
    app.get('/api/config/other', (_req, res) => {
      res.json({ other: true });
    });

    await request(app).post('/api/files/speech/stt').expect(403);
    await request(app).post('/api/files/speech/tts/manual').expect(403);
    await request(app).get('/api/files/speech/config/get').expect(200);
    const config = await request(app).get('/api/config').expect(200);
    expect(config.body).toEqual({ appTitle: 'Synthetic', speechLocalOnly: true });
    expect((await request(app).get('/api/config/other')).body).toEqual({ other: true });
  });
});

describe('startHardening', () => {
  const methods = (): HardeningMethods => ({
    findRolesByNames: jest.fn().mockResolvedValue([]),
    getRoleByName: jest.fn(),
    updateAccessPermissions: jest.fn(),
    updateRoleByName: jest.fn(),
    getFiles: jest.fn(),
  });

  it('registers nothing and reads nothing while its env is unset', async () => {
    delete process.env.STRICT_BROWSER_EGRESS;
    delete process.env.SPEECH_LOCAL_ONLY;
    delete process.env.FEEDBACK_TEXT_TABLE;
    delete process.env.ROLE_PERMISSION_CAPS;
    delete process.env.RETENTION_WEEKLY_RESET;
    const app = express();
    const tracked = methods();

    await startHardening({ app, methods: tracked });
    mountAppRoutes(app);

    const config = await request(app).get('/api/config').expect(200);
    expect(config.body).toEqual({ appTitle: 'Synthetic' });
    expect(config.headers['content-security-policy']).toBeUndefined();
    expect(config.headers['permissions-policy']).toBeUndefined();
    await request(app).post('/api/files/speech/stt').expect(200);
    expect(tracked.findRolesByNames).not.toHaveBeenCalled();
  });

  it('turns each piece on with its env', async () => {
    process.env.STRICT_BROWSER_EGRESS = 'true';
    process.env.SPEECH_LOCAL_ONLY = 'true';
    process.env.FEEDBACK_TEXT_TABLE = 'feedback.feedback_texts';
    const app = express();

    await startHardening({ app, methods: methods() });
    mountAppRoutes(app);

    const config = await request(app).get('/api/config').expect(200);
    expect(config.body).toEqual({
      appTitle: 'Synthetic',
      strictBrowserEgress: true,
      speechLocalOnly: true,
      feedbackTexts: true,
    });
    expect(config.headers['content-security-policy']).toBe(STRICT_EGRESS_POLICY);
    expect(config.headers['permissions-policy']).toBe(STRICT_PERMISSIONS_POLICY);
    await request(app).post('/api/files/speech/stt').expect(403);
  });
});
