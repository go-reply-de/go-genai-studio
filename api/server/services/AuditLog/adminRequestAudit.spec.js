const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { createAdminRequestAudit } = require('./adminRequestAudit');

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

/** A miniature of the real mounts in api/server/index.js, with stub handlers. */
function buildApp({ user, enabled = true, write } = {}) {
  const lines = [];
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use(
    ['/api/admin', '/api/roles'],
    createAdminRequestAudit({ enabled, write: write ?? ((line) => lines.push(line)) }),
  );
  const authenticate = (req, _res, next) => {
    req.user = user;
    next();
  };

  const adminAuth = express.Router();
  adminAuth.post('/login/local', authenticate, (_req, res) => res.json({ token: 't' }));
  adminAuth.get('/oauth/:provider/callback', authenticate, (req, res) =>
    res.redirect(req.user ? '/panel?code=c' : '/panel?error=auth_failed'),
  );
  adminAuth.post('/oauth/refresh', (_req, res) => res.json({ token: 't' }));
  adminAuth.post('/login/broken', (_req, _res, next) => next(new Error('boom')));
  app.use('/api/admin', adminAuth);

  const adminRoles = express.Router();
  adminRoles.patch('/:name', authenticate, (req, res) => {
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

  return { app, lines };
}

/** The line is printed on the response's 'finish', which can trail the client's read. */
async function printed(lines, count = 1) {
  for (let i = 0; i < 50 && (i < 5 || lines.length < count); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return lines.map((line) => {
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    return JSON.parse(line);
  });
}

describe('createAdminRequestAudit', () => {
  it('records a successful change with its route, target and new values', async () => {
    const { app, lines } = buildApp({ user: admin });

    await request(app)
      .patch('/api/admin/roles/editor')
      .send({ description: 'Editors' })
      .expect(200);

    const [line] = await printed(lines);
    expect(line.severity).toBe('NOTICE');
    expect(line.message).toBe('admin PATCH /api/admin/roles/:name 200');
    expect(line.adminRequest).toMatchObject({
      schemaVersion: 1,
      outcome: 'success',
      status: 200,
      method: 'PATCH',
      route: '/api/admin/roles/:name',
      path: '/api/admin/roles/editor',
      params: { name: 'editor' },
      body: { description: 'Editors' },
      actor: {
        id: '64b000000000000000000001',
        role: 'ADMIN',
        name: 'Ada Admin',
        email: 'ada@example.org',
      },
    });
    expect(line.adminRequest.context.ip).toBeTruthy();
    expect(Date.parse(line.adminRequest.startedAt)).not.toBeNaN();
  });

  it('records the role permission toggles of the chat UI', async () => {
    const { app, lines } = buildApp({ user: admin });

    await request(app).put('/api/roles/USER/agents').send({ USE: true, CREATE: false });

    const [line] = await printed(lines);
    expect(line.adminRequest).toMatchObject({
      route: '/api/roles/:roleName/agents',
      params: { roleName: 'USER' },
      body: { USE: true, CREATE: false },
    });
  });

  it('records a denied attempt without naming a caller who is not an admin', async () => {
    const { app, lines } = buildApp({ user: clinician });

    await request(app).delete('/api/admin/roles/editor').expect(403);

    const [line] = await printed(lines);
    expect(line.severity).toBe('WARNING');
    expect(line.adminRequest.outcome).toBe('denied');
    expect(line.adminRequest.actor).toEqual({ id: '64b000000000000000000002', role: 'USER' });
  });

  it('ignores reads and token refreshes', async () => {
    const { app, lines } = buildApp({ user: admin });

    await request(app).get('/api/roles/USER').expect(200);
    await request(app).post('/api/admin/oauth/refresh').send({ refresh_token: 'r' }).expect(200);

    expect(await printed(lines, 0)).toEqual([]);
  });

  it('records admin logins without their credentials', async () => {
    const { app, lines } = buildApp({ user: admin });

    await request(app)
      .post('/api/admin/login/local')
      .send({ email: 'ada@example.org', password: 'hunter2' });
    await request(app).get('/api/admin/oauth/openid/callback?code=abc&state=xyz').expect(302);

    const [local, sso] = await printed(lines, 2);
    for (const { adminRequest } of [local, sso]) {
      expect(adminRequest.outcome).toBe('success');
      expect(adminRequest.actor.name).toBe('Ada Admin');
      expect(adminRequest.body).toBeUndefined();
      expect(adminRequest.query).toBeUndefined();
    }
    expect(JSON.stringify(lines)).not.toMatch(/hunter2|abc|xyz/);
  });

  it('leaves out the route rather than print a wrong one after an error', async () => {
    const { app, lines } = buildApp({ user: undefined });

    await request(app).post('/api/admin/login/broken').expect(500);

    const [line] = await printed(lines);
    expect(line.message).toBe('admin POST /api/admin/login/broken 500');
    expect(line.adminRequest.outcome).toBe('failure');
    expect(line.adminRequest.route).toBeUndefined();
  });

  it('records a failed SSO login as a failure, although it ends in a redirect', async () => {
    const { app, lines } = buildApp({ user: undefined });

    await request(app).get('/api/admin/oauth/openid/callback?code=abc').expect(302);

    const [line] = await printed(lines);
    expect(line.adminRequest.outcome).toBe('failure');
    expect(line.adminRequest.actor).toBeNull();
  });

  it('treats an odd-cased or percent-encoded login path as a login', async () => {
    const { app, lines } = buildApp({ user: admin });

    await request(app).post('/API/Admin/LOGIN/local').send({ email: 'e', note: 'hunter2' });
    await request(app).post('/api/admin/%6Cogin/local').send({ email: 'e', note: 'hunter2' });

    await printed(lines, 2);
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain('hunter2');
  });

  it('never prints secrets from config overrides, but keeps everything else', async () => {
    const { app, lines } = buildApp({ user: admin });

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

    const [put, patch] = await printed(lines, 2);
    const [proxy, envBacked] = put.adminRequest.body.overrides.endpoints.custom;
    expect(proxy).toEqual({
      name: 'proxy',
      baseURL: 'https://llm.example.org',
      apiKey: '[redacted]',
      headers: { Authorization: '[redacted]', 'X-Org': '[redacted]' },
    });
    expect(envBacked.apiKey).toBe('${PROXY_API_KEY}');
    expect(put.adminRequest.body.overrides.mcpServers.github).toEqual({
      url: 'https://mcp.example.org',
      env: { GITHUB_TOKEN: '[redacted]' },
    });
    expect(put.adminRequest.body.overrides.banner.note).toBe('[redacted]');
    expect(put.adminRequest.body.priority).toBe(10);
    expect(patch.adminRequest.body.entries).toEqual([
      { fieldPath: 'mcpServers.github.headers.Authorization', value: '[redacted]' },
      { fieldPath: 'interface.temporaryChat', value: false },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/sk-live|abc|ghp_secret|zzz|pasted-by-mistake/);
  });

  it('shrinks an oversized body to its keys', async () => {
    const { app, lines } = buildApp({ user: admin });

    await request(app)
      .patch('/api/admin/roles/editor')
      .send({ description: 'x'.repeat(40 * 1024), label: 'Editors' });

    const [line] = await printed(lines);
    expect(line.adminRequest.body).toEqual({
      truncated: true,
      bytes: expect.any(Number),
      keys: ['description', 'label'],
    });
    expect(line.adminRequest.body.bytes).toBeGreaterThan(32 * 1024);
  });

  it('does nothing unless AUDIT_LOG_STDOUT is set', async () => {
    const saved = process.env.AUDIT_LOG_STDOUT;
    delete process.env.AUDIT_LOG_STDOUT;
    try {
      const lines = [];
      const app = express();
      app.use('/api/admin', createAdminRequestAudit({ write: (line) => lines.push(line) }));
      app.post('/api/admin/roles', (_req, res) => res.json({}));

      await request(app).post('/api/admin/roles').send({ name: 'x' }).expect(200);

      expect(await printed(lines, 0)).toEqual([]);
    } finally {
      if (saved !== undefined) {
        process.env.AUDIT_LOG_STDOUT = saved;
      }
    }
  });

  it('keeps serving the request when printing fails', async () => {
    const write = jest.fn(() => {
      throw new Error('EPIPE');
    });
    const { app } = buildApp({ user: admin, write });

    const res = await request(app).patch('/api/admin/roles/editor').send({ description: 'x' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await printed([], 0);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('is mounted on both route families ahead of the admin routes in api/server/index.js', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    const mount = source.indexOf(
      "app.use(['/api/admin', '/api/roles'], createAdminRequestAudit());",
    );

    expect(mount).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(source.indexOf("app.use('/api/admin', routes.adminAuth);"));
    expect(mount).toBeLessThan(source.indexOf("app.use('/api/roles', routes.roles);"));
  });
});
