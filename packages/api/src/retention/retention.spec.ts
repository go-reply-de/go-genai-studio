import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import { promises as fs } from 'fs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getWeeklyReset, nextWeeklyReset } from '@librechat/data-schemas';
import type { RetentionMaintenanceDeps } from './index';
import type { OrphanUploadDeps } from './orphans';
import { sweepOrphanUploads, ORPHAN_UPLOAD_MS } from './orphans';
import { sweepStaleUploads, STALE_UPLOAD_MS } from './uploads';
import { startRetentionMaintenance } from './index';
import { ensureLogsExpiryIndex } from './logs';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const originalEnv = { ...process.env };
const HOUR_MS = 60 * 60 * 1000;
const OWNER = '5f1b2c3d4e5f6a7b8c9d0e1f';
const OTHER_OWNER = '6a7b8c9d0e1f5f1b2c3d4e5f';
const fileId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let root: string;
let uploadsPath: string;
let imagesPath: string;

function useWeeklyReset(enabled: boolean): void {
  if (enabled) {
    process.env.RETENTION_WEEKLY_RESET = 'SUN 23:00';
    process.env.RETENTION_WEEKLY_RESET_TZ = 'Europe/Berlin';
    return;
  }
  delete process.env.RETENTION_WEEKLY_RESET;
  delete process.env.RETENTION_WEEKLY_RESET_TZ;
}

/** Writes a file under `base` and backdates it by `ageMs`. */
async function place(base: string, relative: string, ageMs: number): Promise<string> {
  const file = path.join(base, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'synthetic content');
  const at = new Date(Date.now() - ageMs);
  await fs.utimes(file, at, at);
  return file;
}

async function exists(file: string): Promise<boolean> {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function orphanDeps(overrides: Partial<OrphanUploadDeps> = {}): OrphanUploadDeps {
  return {
    findStoredFileIds: jest.fn().mockResolvedValue(new Set<string>()),
    findAgentFileIds: jest.fn().mockResolvedValue(new Set<string>()),
    deleteVectors: jest.fn().mockResolvedValue(true),
    now: () => Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-storage-'));
  uploadsPath = path.join(root, 'uploads');
  imagesPath = path.join(root, 'images');
  await Promise.all([fs.mkdir(uploadsPath), fs.mkdir(imagesPath)]);
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await fs.rm(root, { recursive: true, force: true });
});

describe('sweepStaleUploads', () => {
  it('removes staged uploads past the cutoff and keeps fresh ones', async () => {
    const stale = await place(uploadsPath, 'temp/user-a/TESTFALL-DIMEAS-01.pdf', 2 * HOUR_MS);
    const otherStale = await place(uploadsPath, 'temp/user-b/synthetic.png', 3 * HOUR_MS);
    const fresh = await place(uploadsPath, 'temp/user-a/in-flight.pdf', 60_000);

    const deleted = await sweepStaleUploads(uploadsPath, new Date(Date.now() - STALE_UPLOAD_MS));

    expect(deleted).toBe(2);
    expect(await exists(stale)).toBe(false);
    expect(await exists(otherStale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('leaves directories, links and files outside the temp folders alone', async () => {
    const stale = await place(uploadsPath, 'temp/user-a/old.pdf', 2 * HOUR_MS);
    const nested = path.join(uploadsPath, 'temp', 'user-a', 'nested');
    await fs.mkdir(nested);
    const outside = await place(uploadsPath, 'user-a/stored.pdf', 2 * HOUR_MS);
    const link = path.join(uploadsPath, 'temp', 'user-a', 'link.pdf');
    await fs.symlink(outside, link);

    await sweepStaleUploads(uploadsPath, new Date(Date.now() - STALE_UPLOAD_MS));

    expect(await exists(stale)).toBe(false);
    expect(await exists(nested)).toBe(true);
    expect(await exists(outside)).toBe(true);
    expect(await exists(link)).toBe(true);
  });

  it('treats a missing temp folder as empty', async () => {
    await expect(sweepStaleUploads(uploadsPath, new Date())).resolves.toBe(0);
  });
});

describe('sweepOrphanUploads', () => {
  it('removes old blobs without a files row, with their vectors', async () => {
    const upload = await place(uploadsPath, `${OWNER}/${fileId(1)}__report.pdf`, 2 * HOUR_MS);
    const image = await place(imagesPath, `${OTHER_OWNER}/${fileId(2)}__scan.webp`, 2 * HOUR_MS);
    const deps = orphanDeps();

    const result = await sweepOrphanUploads([uploadsPath, imagesPath], deps);

    expect(result).toEqual({ deleted: 2, retained: 0, failed: 0 });
    expect(await exists(upload)).toBe(false);
    expect(await exists(image)).toBe(false);
    expect(deps.deleteVectors).toHaveBeenCalledWith(OWNER, fileId(1));
    expect(deps.deleteVectors).toHaveBeenCalledWith(OTHER_OWNER, fileId(2));
  });

  it('keeps blobs with a files row, an agent reference or no hour behind them', async () => {
    const stored = await place(uploadsPath, `${OWNER}/${fileId(1)}__kept.pdf`, 2 * HOUR_MS);
    const agent = await place(uploadsPath, `${OWNER}/${fileId(2)}__regelwerk.pdf`, 2 * HOUR_MS);
    const young = await place(uploadsPath, `${OWNER}/${fileId(3)}__new.pdf`, ORPHAN_UPLOAD_MS / 2);
    const deps = orphanDeps({
      findStoredFileIds: jest.fn().mockResolvedValue(new Set([fileId(1)])),
      findAgentFileIds: jest.fn().mockResolvedValue(new Set([fileId(2)])),
    });

    const result = await sweepOrphanUploads([uploadsPath], deps);

    expect(result).toEqual({ deleted: 0, retained: 0, failed: 0 });
    expect(await exists(stored)).toBe(true);
    expect(await exists(agent)).toBe(true);
    expect(await exists(young)).toBe(true);
    expect(deps.deleteVectors).not.toHaveBeenCalled();
  });

  it('touches nothing outside `<root>/<user id>/<file_id>__<name>` regular files', async () => {
    const avatar = await place(imagesPath, `${OWNER}/avatar-1700000000.png`, 2 * HOUR_MS);
    const temp = await place(uploadsPath, `temp/${OWNER}/${fileId(1)}__staged.pdf`, 2 * HOUR_MS);
    const notOwner = await place(uploadsPath, `assets/${fileId(2)}__logo.png`, 2 * HOUR_MS);
    const nested = await place(uploadsPath, `${OWNER}/sub/${fileId(3)}__deep.pdf`, 2 * HOUR_MS);
    const target = await place(root, `outside/${fileId(4)}__secret.pdf`, 2 * HOUR_MS);
    const link = path.join(uploadsPath, OWNER, `${fileId(4)}__secret.pdf`);
    await fs.symlink(target, link);
    const deps = orphanDeps();

    const result = await sweepOrphanUploads([uploadsPath, imagesPath], deps);

    expect(result.deleted).toBe(0);
    for (const file of [avatar, temp, notOwner, nested, target, link]) {
      expect(await exists(file)).toBe(true);
    }
  });

  it('keeps a blob for a vector retry until its week has ended', async () => {
    useWeeklyReset(true);
    const reset = getWeeklyReset();
    if (reset == null) {
      throw new Error('The spec expects RETENTION_WEEKLY_RESET to be set');
    }
    const boundary = nextWeeklyReset(reset).getTime();
    const blob = await place(uploadsPath, `${OWNER}/${fileId(1)}__report.pdf`, 0);
    const written = new Date(boundary - 3 * HOUR_MS);
    await fs.utimes(blob, written, written);
    const deleteVectors = jest.fn().mockResolvedValue(false);

    const before = orphanDeps({ deleteVectors, now: () => boundary - HOUR_MS });
    expect(await sweepOrphanUploads([uploadsPath], before)).toEqual({
      deleted: 0,
      retained: 1,
      failed: 0,
    });
    expect(await exists(blob)).toBe(true);

    const after = orphanDeps({ deleteVectors, now: () => boundary + 60_000 });
    expect(await sweepOrphanUploads([uploadsPath], after)).toEqual({
      deleted: 1,
      retained: 0,
      failed: 0,
    });
    expect(await exists(blob)).toBe(false);
  });
});

describe('ensureLogsExpiryIndex', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    /* A one-second TTL pass lets the spec watch MongoDB delete an expired entry. */
    mongoServer = await MongoMemoryServer.create({
      instance: { args: ['--setParameter', 'ttlMonitorSleepSecs=1'] },
    });
    await mongoose.connect(mongoServer.getUri());
  }, DB_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  }, DB_SETUP_TIMEOUT_MS);

  it('lets MongoDB drop expired entries and keep the ones without a TTL', async () => {
    await ensureLogsExpiryIndex();
    await ensureLogsExpiryIndex();
    const logs = mongoose.connection.collection('logs');
    await logs.insertMany([
      { key: 'ban:synthetic-user', value: '{}', expiresAt: new Date(Date.now() - 1000) },
      { key: 'ENCODED_DOMAINS:synthetic', value: 'synthetic', expiresAt: null },
    ]);

    expect(await logs.listIndexes().toArray()).toContainEqual(
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    );
    await waitFor(async () => (await logs.countDocuments({ key: 'ban:synthetic-user' })) === 0);
    expect(await logs.countDocuments({ key: 'ENCODED_DOMAINS:synthetic' })).toBe(1);
  }, 30_000);
});

describe('startRetentionMaintenance', () => {
  const deps = (leader: boolean): RetentionMaintenanceDeps => ({
    ...orphanDeps(),
    isLeader: jest.fn().mockResolvedValue(leader),
  });

  it('does nothing without RETENTION_WEEKLY_RESET', async () => {
    useWeeklyReset(false);
    const stale = await place(uploadsPath, 'temp/user-a/old.pdf', 2 * HOUR_MS);
    const orphan = await place(uploadsPath, `${OWNER}/${fileId(1)}__report.pdf`, 2 * HOUR_MS);
    const leader = deps(true);

    expect(startRetentionMaintenance({ uploadsPath, imagesPath }, leader)).toBeNull();
    expect(leader.isLeader).not.toHaveBeenCalled();
    expect(await exists(stale)).toBe(true);
    expect(await exists(orphan)).toBe(true);
  });

  it('sweeps on the leader and leaves the shared volume to it elsewhere', async () => {
    useWeeklyReset(true);
    const stale = await place(uploadsPath, 'temp/user-a/old.pdf', 2 * HOUR_MS);
    const orphan = await place(uploadsPath, `${OWNER}/${fileId(1)}__report.pdf`, 2 * HOUR_MS);

    const follower = startRetentionMaintenance({ uploadsPath, imagesPath }, deps(false));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await exists(stale)).toBe(true);
    expect(await exists(orphan)).toBe(true);

    const leader = startRetentionMaintenance({ uploadsPath, imagesPath }, deps(true));
    await waitFor(async () => !(await exists(stale)) && !(await exists(orphan)));
    clearInterval(follower ?? undefined);
    clearInterval(leader ?? undefined);
  });
});
