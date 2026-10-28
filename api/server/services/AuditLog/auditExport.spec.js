const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { logger } = require('@librechat/data-schemas');
const store = require('./adminAuditStore');
const { createExporter, exportConfig, missingRanges } = require('./auditExport');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00Z');
const END = '2027-03-31T21:59:59.000Z';
const config = {
  bucket: 'audit-bucket',
  retainUntil: Date.parse(END),
  retentionDays: 365,
  intervalMs: 5 * 60 * 1000,
  storageUrl: 'https://storage.example',
};

/** Stands in for the GCS JSON API: create-only uploads, plus the metadata server's token. */
function fakeStorage() {
  const objects = new Map();
  let failures = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (url.startsWith('http://metadata')) {
      return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    }
    if (failures > 0) {
      failures--;
      return { ok: false, status: 503, text: async () => 'unavailable' };
    }
    const boundary = /boundary=(.+)$/.exec(opts.headers['Content-Type'])[1];
    const parts = opts.body.split(`--${boundary}`);
    const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1]);
    const content = parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
    if (objects.has(metadata.name)) {
      return { ok: false, status: 412, text: async () => 'conditionNotMet' };
    }
    objects.set(metadata.name, {
      url,
      auth: opts.headers.Authorization,
      metadata,
      lines: content.split('\n').map((line) => JSON.parse(line)),
    });
    return { ok: true, status: 200, text: async () => '' };
  };
  return { objects, fetchImpl, failNext: (n) => (failures = n) };
}

describe('audit export', () => {
  let mongoServer;
  let clock;
  let storage;
  let purgeGrantLog;
  const exporter = (overrides = {}) =>
    createExporter({
      config,
      store,
      fetchImpl: storage.fetchImpl,
      purgeGrantLog,
      now: () => clock,
      holder: 'replica-a',
      ...overrides,
    });

  async function addEvent({ outcome = 'success', createdAt = new Date(clock - 60_000) } = {}) {
    const seq = await store.nextSeq();
    const id = `evt-${seq}`;
    await store.recordStart({
      _id: id,
      seq,
      schemaVersion: 2,
      outcome: 'pending',
      method: 'PATCH',
      path: '/api/admin/roles/editor',
      body: { description: 'Editors' },
      context: { ip: '10.0.0.1' },
      createdAt,
    });
    if (outcome !== 'pending') {
      await store.recordEnd(id, {
        outcome,
        status: 200,
        actor: { id: 'u1', role: 'ADMIN', name: 'Ada Admin' },
      });
    }
    return seq;
  }

  const addGrant = (chainKey, seq, extra = {}) =>
    mongoose.connection.collection('auditlogs').insertOne({
      chainKey,
      seq,
      prevHash: `prev-${seq}`,
      hash: `hash-${seq}`,
      schemaVersion: 1,
      category: 'grant',
      action: 'grant.assigned',
      outcome: 'success',
      severity: 'info',
      actor: { type: 'user', id: 'u1', name: 'Ada Admin' },
      target: { type: 'role', id: 'audit-test', name: 'audit-test' },
      metadata: { capability: 'read:groups' },
      createdAt: new Date(clock - 60_000),
      ...extra,
    });

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db.dropDatabase();
    await store.ensureIndexes();
    clock = NOW;
    storage = fakeStorage();
    purgeGrantLog = jest.fn(async () => ({ deletedCount: 0 }));
    jest.clearAllMocks();
  });

  it('uploads finished requests as one locked file, and moves the bookmark only afterwards', async () => {
    await addEvent();
    await addEvent();
    await addEvent();

    await exporter().runOnce();

    expect([...storage.objects.keys()]).toEqual([
      'admin-requests/2026/10/05/000000000001-000000000003.ndjson',
    ]);
    const [file] = storage.objects.values();
    expect(file.url).toContain(
      '/upload/storage/v1/b/audit-bucket/o?uploadType=multipart&ifGenerationMatch=0',
    );
    expect(file.auth).toBe('Bearer tok');
    expect(file.metadata).toMatchObject({
      contentType: 'application/x-ndjson',
      customTime: END,
      retention: { mode: 'Locked', retainUntilTime: END },
    });
    expect(file.lines.map((line) => line.recordType)).toEqual([
      'adminRequest',
      'adminRequest',
      'adminRequest',
      'batch',
    ]);
    expect(file.lines[0]).toMatchObject({
      eventId: 'evt-1',
      seq: 1,
      outcome: 'success',
      actor: { name: 'Ada Admin' },
      bodyJson: '{"description":"Editors"}',
    });
    expect(file.lines[3]).toMatchObject({ fromSeq: 1, toSeq: 3, count: 3, gaps: null });

    const state = await store.getState(store.EVENTS);
    expect(state.lastSeq).toBe(3);
    expect(state.pending).toBeUndefined();
    const events = await store.eventsBetween(1, 3);
    expect(events.every((event) => event.deleteAt.toISOString() === END && event.exportedAt)).toBe(
      true,
    );
  });

  it('holds back a request that is still running, and everything after it, until it is stale', async () => {
    await addEvent();
    await addEvent({ outcome: 'pending', createdAt: new Date(clock) });
    await addEvent();

    await exporter().runOnce();
    expect([...storage.objects.keys()]).toEqual([
      'admin-requests/2026/10/05/000000000001-000000000001.ndjson',
    ]);

    clock += 11 * 60 * 1000;
    await exporter().runOnce();
    const second = storage.objects.get(
      'admin-requests/2026/10/05/000000000002-000000000003.ndjson',
    );
    expect(second.lines.slice(0, 2).map((line) => [line.seq, line.outcome])).toEqual([
      [2, 'pending'],
      [3, 'success'],
    ]);
  });

  it('marks sequence numbers that were drawn but never stored as gaps', async () => {
    await store.nextSeq();
    await addEvent();
    await addEvent();

    await exporter().runOnce();

    const [file] = storage.objects.values();
    expect(file.lines.at(-1)).toMatchObject({ fromSeq: 1, toSeq: 3, count: 2, gaps: '1' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('missing: 1'));
  });

  it('retries a failed upload under the same name, then continues', async () => {
    await addEvent();
    await addEvent();
    storage.failNext(1);

    await expect(exporter().runOnce()).rejects.toThrow('503');
    expect((await store.getState(store.EVENTS)).pending).toMatchObject({ fromSeq: 1, toSeq: 2 });
    expect((await store.eventsBetween(1, 2)).some((event) => event.exportedAt)).toBe(false);

    await addEvent();
    await exporter().runOnce();

    expect([...storage.objects.keys()]).toEqual([
      'admin-requests/2026/10/05/000000000001-000000000002.ndjson',
      'admin-requests/2026/10/05/000000000003-000000000003.ndjson',
    ]);
    expect((await store.getState(store.EVENTS)).lastSeq).toBe(3);
  });

  it('treats a file that already exists as done, after a crash between upload and bookmark', async () => {
    await addEvent();
    await addEvent();
    const name = 'admin-requests/2026/10/05/000000000001-000000000002.ndjson';
    storage.objects.set(name, { metadata: { name }, lines: [] });
    await store.setState(store.EVENTS, {
      lastSeq: 0,
      pending: { fromSeq: 1, toSeq: 2, until: END, name },
    });

    await exporter().runOnce();

    expect(storage.objects.size).toBe(1);
    expect((await store.getState(store.EVENTS)).lastSeq).toBe(2);
  });

  it('exports the grant log per chain with every hashed field, and purges MongoDB a year later', async () => {
    await addGrant('__platform__', 1);
    await addGrant('__platform__', 2);
    await addGrant('tenant:t1', 1);

    await exporter().runOnce();

    const platform = storage.objects.get(
      'grant-log/__platform__/2026/10/05/000000000001-000000000002.ndjson',
    );
    expect(platform.lines[0]).toMatchObject({
      recordType: 'grantLog',
      chainKey: '__platform__',
      seq: 1,
      prevHash: 'prev-1',
      hash: 'hash-1',
      action: 'grant.assigned',
      metadataJson: '{"capability":"read:groups"}',
    });
    expect(platform.metadata.retention).toEqual({ mode: 'Locked', retainUntilTime: END });
    expect(
      storage.objects.has('grant-log/tenant_t1/2026/10/05/000000000001-000000000001.ndjson'),
    ).toBe(true);
    const purges = purgeGrantLog.mock.calls.map(([tenantId, options]) => [tenantId, options]);
    expect(purges).toEqual(
      expect.arrayContaining([
        [undefined, { before: new Date(NOW - 365 * DAY), confirm: true }],
        ['t1', { before: new Date(NOW - 365 * DAY), confirm: true }],
      ]),
    );
  });

  it('never purges grant log entries that are not exported yet', async () => {
    await addGrant('__platform__', 1, { createdAt: new Date(NOW - 400 * DAY) });
    await addGrant('__platform__', 2, { createdAt: new Date(NOW - 390 * DAY) });
    await store.setState('auditlogs:__platform__', { lastSeq: 1 });

    await exporter().purge();

    expect(purgeGrantLog).toHaveBeenCalledWith(undefined, {
      before: new Date(NOW - 390 * DAY),
      confirm: true,
    });
  });

  it("stops exporting at the end date and deletes all of MongoDB's copies", async () => {
    await addEvent();
    await addGrant('__platform__', 1);
    clock = Date.parse(END) + 1000;

    await exporter().runOnce();

    expect(storage.objects.size).toBe(0);
    expect(await store.eventsAfter(0, 10)).toEqual([]);
    expect(purgeGrantLog).toHaveBeenCalledWith(undefined, {
      before: new Date(clock),
      confirm: true,
    });
  });

  it('lets only one replica export at a time', async () => {
    await addEvent();
    await exporter().runOnce();

    await expect(exporter({ holder: 'replica-b' }).runOnce()).resolves.toEqual({ skipped: true });

    clock += 2 * config.intervalMs + 1000;
    await expect(exporter({ holder: 'replica-b' }).runOnce()).resolves.toEqual({ exported: 0 });
  });

  it('locks for one year, but never past the end of the agreement', () => {
    expect(exporter().lockUntil()).toBe(END);
    const longer = createExporter({
      config: { ...config, retainUntil: Date.parse('2030-01-01T00:00:00Z') },
      now: () => NOW,
    });
    expect(longer.lockUntil()).toBe(new Date(NOW + 365 * DAY).toISOString());
  });

  it('reads its settings from the environment, and refuses without a valid end date', () => {
    expect(exportConfig({})).toBeNull();
    expect(
      exportConfig({ AUDIT_EXPORT_BUCKET: 'b', AUDIT_EXPORT_RETAIN_UNTIL: 'soon' }),
    ).toBeNull();
    expect(exportConfig({ AUDIT_EXPORT_BUCKET: 'b', AUDIT_EXPORT_RETAIN_UNTIL: END })).toEqual({
      bucket: 'b',
      retainUntil: Date.parse(END),
      retentionDays: 365,
      intervalMs: 300000,
      storageUrl: 'https://storage.googleapis.com',
    });
  });

  it('lists missing sequence numbers as ranges', () => {
    expect(missingRanges(1, 3, [1, 2, 3])).toEqual([]);
    expect(missingRanges(1, 6, [2, 5])).toEqual(['1', '3-4', '6']);
    expect(missingRanges(4, 5, [])).toEqual(['4-5']);
  });
});
