const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { createAdminRequestAudit, isRecording } = require('./adminRequestAudit');

const admin = {
  _id: { toString: () => '64b000000000000000000001' },
  role: 'ADMIN',
  name: 'Ada Admin',
  email: 'ada@example.org',
};
const clinician = {
  _id: { toString: () => '64b000000000000000000002' },
  role: 'USER',
  name: 'Clara Clinician',
  email: 'clara@example.org',
};
const NOW = Date.parse('2026-10-05T12:00:00Z');
const RECORDING = { bucket: 'audit-bucket', retainUntil: '2027-03-31T21:59:59Z', now: () => NOW };

function memoryStore({ failStart = false, failSeq = false } = {}) {
  const events = new Map();
  let seq = 0;
  return {
    events,
    list: () => [...events.values()].sort((a, b) => a.seq - b.seq),
    nextSeq: async () => {
      if (failSeq) {
        throw new Error('mongo down');
      }
      return ++seq;
    },
    recordStart: async (event) => {
      if (failStart) {
        throw new Error('mongo down');
      }
      events.set(event._id, { ...event });
    },
    recordEnd: async (id, fields) => {
      Object.assign(events.get(id), fields);
    },
  };
}

/** A miniature of the real mounts in api/server/index.js, with stub handlers. */
function buildApp({ user, store = memoryStore(), options = RECORDING, onHandler } = {}) {
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use(['/api/admin', '/api/roles'], createAdminRequestAudit({ store, ...options }));
  const authenticate = (req, _res, next) => {
    req.user = user;
    next();
  };
  const seen = (req) => onHandler?.(req, store);

  const adminAuth = express.Router();
  adminAuth.post('/login/local', authenticate, (req, res) => {
    seen(req);
    res.json({ token: 't' });
  });
  adminAuth.get('/oauth/:provider/callback', authenticate, (req, res) =>
    res.redirect(req.user ? '/panel?code=c' : '/panel?error=auth_failed'),
  );
  adminAuth.post('/oauth/refresh', (_req, res) => res.json({ token: 't' }));
  adminAuth.post('/login/broken', (_req, _res, next) => next(new Error('boom')));
  app.use('/api/admin', adminAuth);

  const adminRoles = express.Router();
  adminRoles.patch('/:name', authenticate, (req, res) => {
    seen(req);
    req.body.description = 'changed by the handler';
    res.json({ ok: true });
  });
  adminRoles.delete('/:name', authenticate, (req, res) =>
    req.user.role === 'ADMIN'
      ? res.json({ ok: true })
      : res.status(403).json({ error: 'Forbidden' }),
  );
  app.use('/api/admin/roles', adminRoles);

  const adminConfig = express.Router();
  adminConfig.put('/:principalType/:principalId', authenticate, (_req, res) => res.json({}));
  adminConfig.patch('/:principalType/:principalId/fields', authenticate, (_req, res) =>
    res.json({}),
  );
  app.use('/api/admin/config', adminConfig);

  const roles = express.Router();
  roles.get('/:roleName', authenticate, (_req, res) => res.json({}));
  roles.put('/:roleName/agents', authenticate, (_req, res) => res.json({}));
  app.use('/api/roles', roles);

  // Like ErrorController: answers after the request has left its router.
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'Internal error' }));

  return { app, store };
}

/** The outcome is stored on the response's 'finish', which can trail the client's read. */
async function settled(store, count = 1) {
  for (let i = 0; i < 50; i++) {
    const done = store.list().filter((event) => event.outcome !== 'pending');
    if (i >= 5 && done.length >= count) {
      break;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return store.list();
}

describe('createAdminRequestAudit', () => {
  it('stores the request before the handler runs, then its outcome', async () => {
    let atHandler;
    const { app, store } = buildApp({
      user: admin,
      onHandler: (_req, s) => {
        atHandler = s.list().map((event) => ({ ...event }));
      },
    });

    await request(app)
      .patch('/api/admin/roles/editor')
      .send({ description: 'Editors' })
      .expect(200);

    expect(atHandler).toHaveLength(1);
    expect(atHandler[0]).toMatchObject({
      seq: 1,
      outcome: 'pending',
      method: 'PATCH',
      path: '/api/admin/roles/editor',
      body: { description: 'Editors' },
    });
    const [event] = await settled(store);
    expect(event).toMatchObject({
      outcome: 'success',
      status: 200,
      route: '/api/admin/roles/:name',
      params: { name: 'editor' },
      body: { description: 'Editors' },
      actor: {
        id: '64b000000000000000000001',
        role: 'ADMIN',
        name: 'Ada Admin',
        email: 'ada@example.org',
      },
    });
    expect(event._id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.context.ip).toBeTruthy();
  });

  it.each([
    ['the record cannot be written', { failStart: true }],
    ['no sequence number can be drawn', { failSeq: true }],
  ])('refuses the request when %s', async (_name, failure) => {
    const handler = jest.fn();
    const { app } = buildApp({ user: admin, store: memoryStore(failure), onHandler: handler });

    const res = await request(app).patch('/api/admin/roles/editor').send({ description: 'x' });

    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it('records the role permission toggles of the chat UI', async () => {
    const { app, store } = buildApp({ user: admin });

    await request(app).put('/api/roles/USER/agents').send({ USE: true, CREATE: false });

    const [event] = await settled(store);
    expect(event).toMatchObject({
      route: '/api/roles/:roleName/agents',
      params: { roleName: 'USER' },
      body: { USE: true, CREATE: false },
    });
  });

  it('records a denied attempt without naming a caller who is not an admin', async () => {
    const { app, store } = buildApp({ user: clinician });

    await request(app).delete('/api/admin/roles/editor').expect(403);

    const [event] = await settled(store);
    expect(event.outcome).toBe('denied');
    expect(event.actor).toEqual({ id: '64b000000000000000000002', role: 'USER' });
  });

  it('ignores reads and token refreshes', async () => {
    const { app, store } = buildApp({ user: admin });

    await request(app).get('/api/roles/USER').expect(200);
    await request(app).post('/api/admin/oauth/refresh').send({ refresh_token: 'r' }).expect(200);

    expect(await settled(store, 0)).toEqual([]);
  });

  it('records admin logins without their credentials', async () => {
    const { app, store } = buildApp({ user: admin });

    await request(app)
      .post('/api/admin/login/local')
      .send({ email: 'ada@example.org', password: 'hunter2' });
    await request(app).get('/api/admin/oauth/openid/callback?code=abc&state=xyz').expect(302);

    const events = await settled(store, 2);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.outcome).toBe('success');
      expect(event.actor.name).toBe('Ada Admin');
      expect(event.body).toBeUndefined();
      expect(event.query).toBeUndefined();
    }
    expect(JSON.stringify(events)).not.toMatch(/hunter2|abc|xyz/);
  });

  it('leaves out the route rather than store a wrong one after an error', async () => {
    const { app, store } = buildApp({ user: undefined });

    await request(app).post('/api/admin/login/broken').expect(500);

    const [event] = await settled(store);
    expect(event.outcome).toBe('failure');
    expect(event.route).toBeNull();
  });

  it('records a failed SSO login as a failure, although it ends in a redirect', async () => {
    const { app, store } = buildApp({ user: undefined });

    await request(app).get('/api/admin/oauth/openid/callback?code=abc').expect(302);

    const [event] = await settled(store);
    expect(event.outcome).toBe('failure');
    expect(event.actor).toBeNull();
  });

  it('treats an odd-cased or percent-encoded login path as a login', async () => {
    const { app, store } = buildApp({ user: admin });

    await request(app).post('/API/Admin/LOGIN/local').send({ email: 'e', note: 'hunter2' });
    await request(app).post('/api/admin/%6Cogin/local').send({ email: 'e', note: 'hunter2' });

    const events = await settled(store, 2);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('hunter2');
  });

  it('never stores secrets from config overrides, but keeps everything else', async () => {
    const { app, store } = buildApp({ user: admin });

    await request(app)
      .put('/api/admin/config/role/USER')
      .send({
        priority: 10,
        overrides: {
          endpoints: {
            custom: [
              {
                name: 'proxy',
                baseURL: 'https://llm.example.org',
                apiKey: 'sk-live-123',
                headers: { Authorization: 'Bearer abc', 'X-Org': 'uksh' },
              },
              { name: 'env-backed', apiKey: '${PROXY_API_KEY}' },
            ],
          },
          mcpServers: {
            github: { url: 'https://mcp.example.org', env: { GITHUB_TOKEN: 'ghp_secret' } },
          },
          banner: { note: 'Bearer pasted-by-mistake' },
        },
      });
    await request(app)
      .patch('/api/admin/config/role/USER/fields')
      .send({
        entries: [
          { fieldPath: 'mcpServers.github.headers.Authorization', value: 'Bearer zzz' },
          { fieldPath: 'interface.temporaryChat', value: false },
        ],
      });

    const [put, patch] = await settled(store, 2);
    const [proxy, envBacked] = put.body.overrides.endpoints.custom;
    expect(proxy).toEqual({
      name: 'proxy',
      baseURL: 'https://llm.example.org',
      apiKey: '[redacted]',
      headers: { Authorization: '[redacted]', 'X-Org': '[redacted]' },
    });
    expect(envBacked.apiKey).toBe('${PROXY_API_KEY}');
    expect(put.body.overrides.mcpServers.github).toEqual({
      url: 'https://mcp.example.org',
      env: { GITHUB_TOKEN: '[redacted]' },
    });
    expect(put.body.overrides.banner.note).toBe('[redacted]');
    expect(put.body.priority).toBe(10);
    expect(patch.body.entries).toEqual([
      { fieldPath: 'mcpServers.github.headers.Authorization', value: '[redacted]' },
      { fieldPath: 'interface.temporaryChat', value: false },
    ]);
    expect(JSON.stringify(store.list())).not.toMatch(
      /sk-live|abc|ghp_secret|zzz|pasted-by-mistake/,
    );
  });

  it('shrinks an oversized body to its keys', async () => {
    const { app, store } = buildApp({ user: admin });

    await request(app)
      .patch('/api/admin/roles/editor')
      .send({ description: 'x'.repeat(40 * 1024), label: 'Editors' });

    const [event] = await settled(store);
    expect(event.body).toEqual({
      truncated: true,
      bytes: expect.any(Number),
      keys: ['description', 'label'],
    });
  });

  it.each([
    ['no bucket is configured', { ...RECORDING, bucket: undefined }],
    ['no end date is configured', { ...RECORDING, retainUntil: undefined }],
    [
      'the retention period has ended',
      { ...RECORDING, now: () => Date.parse('2027-04-01T00:00:00Z') },
    ],
  ])('records nothing when %s', async (_name, options) => {
    const { app, store } = buildApp({ user: admin, options });

    await request(app).patch('/api/admin/roles/editor').send({ name: 'x' }).expect(200);

    expect(await settled(store, 0)).toEqual([]);
  });

  it('refuses the password login when switched off, and records the attempt', async () => {
    const handler = jest.fn();
    const { app, store } = buildApp({
      user: admin,
      options: { ...RECORDING, localLoginAllowed: false },
      onHandler: handler,
    });

    const res = await request(app)
      .post('/api/admin/login/local')
      .send({ email: 'ada@example.org', password: 'hunter2' });

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    const [event] = await settled(store);
    expect(event).toMatchObject({ outcome: 'denied', reason: 'password login disabled' });
    expect(JSON.stringify(event)).not.toContain('hunter2');
  });

  it('refuses the password login when switched off even while nothing is recorded', async () => {
    const { app, store } = buildApp({
      user: admin,
      options: { ...RECORDING, bucket: undefined, localLoginAllowed: false },
    });

    await request(app)
      .post('/api/admin/login/local')
      .send({ email: 'e', password: 'p' })
      .expect(403);

    expect(await settled(store, 0)).toEqual([]);
  });

  it('decides recording from bucket and end date', () => {
    expect(isRecording('b', '2027-03-31T21:59:59Z', NOW)).toBe(true);
    expect(isRecording('', '2027-03-31T21:59:59Z', NOW)).toBe(false);
    expect(isRecording('b', 'not a date', NOW)).toBe(false);
    expect(isRecording('b', '2026-01-01T00:00:00Z', NOW)).toBe(false);
  });

  it('is mounted ahead of the admin routes, and the export starts with the server', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    const mount = source.indexOf(
      "app.use(['/api/admin', '/api/roles'], createAdminRequestAudit());",
    );

    expect(mount).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(source.indexOf("app.use('/api/admin', routes.adminAuth);"));
    expect(mount).toBeLessThan(source.indexOf("app.use('/api/roles', routes.roles);"));
    expect(source).toContain('startAuditExport();');
  });
});
