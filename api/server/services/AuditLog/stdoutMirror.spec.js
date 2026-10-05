// Before any require: ~/models wraps recordAuditEntry when it loads.
process.env.AUDIT_LOG_STDOUT = 'true';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, createMethods } = require('@librechat/data-schemas');
const { mirrorAuditEntries } = require('./stdoutMirror');

/** Independent verifier: the canonical form recordAuditEntry hashes, rebuilt from a printed copy. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function rehash(entry) {
  const canonical = {
    v: entry.schemaVersion,
    category: entry.category,
    action: entry.action,
    outcome: entry.outcome,
    severity: entry.severity,
    actor: { type: entry.actor.type, id: entry.actor.id ?? null, name: entry.actor.name },
    target: {
      type: entry.target.type,
      id: entry.target.id ?? null,
      name: entry.target.name ?? null,
    },
    metadata: entry.metadata ?? null,
    context: entry.context
      ? {
          requestId: entry.context.requestId ?? null,
          ip: entry.context.ip ?? null,
          userAgent: entry.context.userAgent ?? null,
          sessionId: entry.context.sessionId ?? null,
        }
      : null,
    tenantId: entry.tenantId ?? null,
    chainKey: entry.chainKey,
    seq: entry.seq,
    prevHash: entry.prevHash,
    createdAt: entry.createdAt,
  };
  return crypto.createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

const grant = {
  action: 'grant.assigned',
  actor: { type: 'user', id: '65a1f0c2e4b0a1b2c3d4e5f6', name: 'Admin Example' },
  target: { type: 'user', id: '64b2e0c2e4b0a1b2c3d4e5f6', name: '64b2e0c2e4b0a1b2c3d4e5f6' },
  metadata: { capability: 'read:users' },
  context: { ip: '10.1.2.3', userAgent: 'Mozilla/5.0', requestId: 'req-1' },
};

describe('mirrorAuditEntries', () => {
  let mongoServer;
  let recordAuditEntry;
  let written;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    ({ recordAuditEntry } = createMethods(mongoose));
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    written = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['a platform entry with request context', grant],
    ['a tenant entry without context', { ...grant, context: undefined, tenantId: 'tenant-a' }],
  ])('prints %s as one JSON line that re-verifies on its own', async (_name, input) => {
    const doc = await mirrorAuditEntries(recordAuditEntry)(input);

    expect(written).toHaveLength(1);
    expect(written[0].endsWith('\n')).toBe(true);
    expect(written[0].slice(0, -1)).not.toContain('\n');
    const { auditLog } = JSON.parse(written[0]);
    expect(auditLog.hash).toBe(doc.hash);
    expect(rehash(auditLog)).toBe(doc.hash);
  });

  it('leaves recordAuditEntry untouched unless AUDIT_LOG_STDOUT is set', () => {
    expect(mirrorAuditEntries(recordAuditEntry, { enabled: false })).toBe(recordAuditEntry);
  });

  it('prints nothing when the entry was not recorded', async () => {
    const failOpen = async () => null;

    await expect(mirrorAuditEntries(failOpen)(grant)).resolves.toBeNull();
    expect(written).toHaveLength(0);
  });

  it('passes options through and rethrows, so fail-closed callers still abort', async () => {
    const error = new Error('mongo unavailable');
    const failClosedOnly = async (_input, options) => {
      if (options?.failClosed) {
        throw error;
      }
      return null;
    };

    await expect(mirrorAuditEntries(failClosedOnly)(grant, { failClosed: true })).rejects.toBe(
      error,
    );
    expect(written).toHaveLength(0);
  });

  it('is wired into the recordAuditEntry the admin routes take from ~/models', async () => {
    const db = require('~/models');

    await db.recordAuditEntry(grant);

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]).auditLog.action).toBe('grant.assigned');
  });

  it('keeps the recorded entry when the console write fails', async () => {
    process.stdout.write.mockImplementation(() => {
      throw new Error('EPIPE');
    });

    const doc = await mirrorAuditEntries(recordAuditEntry)(grant);

    expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
