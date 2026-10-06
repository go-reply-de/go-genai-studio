const os = require('os');
const crypto = require('crypto');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const defaultStore = require('./adminAuditStore');

const TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const BATCH = 500;
const MAX_BATCHES_PER_RUN = 20;
/** A request still running after this long is exported with outcome 'pending' rather than held back. */
const STALE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const number = (raw, fallback) => {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

function exportConfig(env = process.env) {
  if (!env.AUDIT_EXPORT_BUCKET) {
    return null;
  }
  const retainUntil = Date.parse(env.AUDIT_EXPORT_RETAIN_UNTIL ?? '');
  if (!Number.isFinite(retainUntil)) {
    logger.error(
      '[auditExport] AUDIT_EXPORT_RETAIN_UNTIL is missing or invalid; nothing is exported',
    );
    return null;
  }
  return {
    bucket: env.AUDIT_EXPORT_BUCKET,
    retainUntil,
    retentionDays: number(env.AUDIT_EXPORT_RETENTION_DAYS, 365),
    intervalMs: number(env.AUDIT_EXPORT_INTERVAL_MS, 5 * 60 * 1000),
    storageUrl: env.AUDIT_EXPORT_STORAGE_URL || 'https://storage.googleapis.com',
  };
}

const pad = (seq) => String(seq).padStart(12, '0');
const datePath = (date) => new Date(date).toISOString().slice(0, 10).replace(/-/g, '/');
const safe = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '_');
const iso = (date) => (date ? new Date(date).toISOString() : null);
const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));

/** Sequence numbers in [fromSeq, toSeq] that no record carries, as "a" or "a-b" ranges. */
function missingRanges(fromSeq, toSeq, seqs) {
  const gaps = [];
  let expected = fromSeq;
  for (const seq of [...seqs, toSeq + 1]) {
    if (seq > expected) {
      gaps.push(expected === seq - 1 ? `${expected}` : `${expected}-${seq - 1}`);
    }
    expected = Math.max(expected, seq + 1);
  }
  return gaps;
}

function adminRequestRecord(doc, exportedAt) {
  return {
    recordType: 'adminRequest',
    eventId: doc._id,
    seq: doc.seq,
    schemaVersion: doc.schemaVersion,
    createdAt: iso(doc.createdAt),
    completedAt: iso(doc.completedAt),
    method: doc.method,
    path: doc.path,
    route: doc.route ?? null,
    outcome: doc.outcome,
    status: doc.status ?? null,
    reason: doc.reason ?? null,
    actor: doc.actor ?? null,
    tenantId: doc.tenantId ?? null,
    context: doc.context ?? null,
    paramsJson: json(doc.params),
    queryJson: json(doc.query),
    bodyJson: json(doc.body),
    durationMs: doc.durationMs ?? null,
    exportedAt,
  };
}

/** Every field the upstream entry hash covers, so the copy re-verifies without MongoDB. */
function grantLogRecord(doc, exportedAt) {
  return {
    recordType: 'grantLog',
    chainKey: doc.chainKey,
    seq: doc.seq,
    prevHash: doc.prevHash,
    hash: doc.hash,
    schemaVersion: doc.schemaVersion,
    category: doc.category,
    action: doc.action,
    outcome: doc.outcome,
    severity: doc.severity,
    actor: doc.actor ?? null,
    target: doc.target ?? null,
    metadataJson: json(doc.metadata),
    context: doc.context ?? null,
    tenantId: doc.tenantId ?? null,
    createdAt: iso(doc.createdAt),
    exportedAt,
  };
}

function createExporter({
  config,
  store = defaultStore,
  fetchImpl = globalThis.fetch,
  tokenUrl = TOKEN_URL,
  purgeGrantLog = (...args) => require('~/models').purgeAuditLogEntries(...args),
  now = () => Date.now(),
  holder = `${os.hostname()}-${process.pid}`,
}) {
  let token = null;

  async function accessToken() {
    if (token && token.expiresAt - 60_000 > now()) {
      return token.value;
    }
    const res = await fetchImpl(tokenUrl, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) {
      throw new Error(`metadata server returned ${res.status}`);
    }
    const body = await res.json();
    token = { value: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return token.value;
  }

  /** Lock and delete date of a file written now: one retention period, never past the agreement's end. */
  const lockUntil = () =>
    new Date(Math.min(now() + config.retentionDays * DAY_MS, config.retainUntil)).toISOString();

  /** Creates the object already locked; an existing one means an earlier attempt got through. */
  async function upload(name, records, until) {
    const boundary = `audit-${crypto.randomUUID()}`;
    const metadata = {
      name,
      contentType: 'application/x-ndjson',
      customTime: until,
      retention: { mode: 'Locked', retainUntilTime: until },
    };
    const content = records.map((record) => JSON.stringify(record)).join('\n');
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/x-ndjson\r\n\r\n${content}\r\n--${boundary}--`;
    const url =
      `${config.storageUrl}/upload/storage/v1/b/${encodeURIComponent(config.bucket)}/o` +
      '?uploadType=multipart&ifGenerationMatch=0&fields=name';
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (res.status === 412) {
      return 'exists';
    }
    if (!res.ok) {
      throw new Error(
        `upload of ${name} failed with ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    return 'created';
  }

  /**
   * Ships one batch per call. The batch is recorded as pending before the upload, so a retry
   * after a crash sends the same records under the same name instead of an overlapping file.
   */
  async function exportAdminRequests() {
    const state = await store.getState(store.EVENTS);
    let { lastSeq = 0, pending } = state;
    if (!pending) {
      const docs = await store.eventsAfter(lastSeq, BATCH);
      const ready = [];
      for (const doc of docs) {
        if (doc.outcome === 'pending' && now() - new Date(doc.createdAt).getTime() < STALE_MS) {
          break;
        }
        ready.push(doc);
      }
      if (!ready.length) {
        return 0;
      }
      const fromSeq = lastSeq + 1;
      const toSeq = ready[ready.length - 1].seq;
      pending = {
        fromSeq,
        toSeq,
        until: lockUntil(),
        name: `admin-requests/${datePath(ready[0].createdAt)}/${pad(fromSeq)}-${pad(toSeq)}.ndjson`,
      };
      await store.setState(store.EVENTS, { lastSeq, pending });
    }

    const docs = await store.eventsBetween(pending.fromSeq, pending.toSeq);
    const exportedAt = new Date(now()).toISOString();
    const gaps = missingRanges(
      pending.fromSeq,
      pending.toSeq,
      docs.map((doc) => doc.seq),
    );
    if (gaps.length) {
      logger.error(`[auditExport] admin request sequence numbers missing: ${gaps.join(', ')}`);
    }
    const records = docs.map((doc) => adminRequestRecord(doc, exportedAt));
    records.push({
      recordType: 'batch',
      source: 'adminRequests',
      fromSeq: pending.fromSeq,
      toSeq: pending.toSeq,
      count: docs.length,
      gaps: gaps.join(',') || null,
      exportedAt,
    });
    await upload(pending.name, records, pending.until);
    await store.markExported(pending.fromSeq, pending.toSeq, {
      exportedAt: new Date(exportedAt),
      deleteAt: new Date(pending.until),
    });
    await store.setState(store.EVENTS, { lastSeq: pending.toSeq }, { pending: '' });
    return docs.length;
  }

  async function exportGrantLog(chainKey) {
    const id = `${store.GRANT_LOG}:${chainKey}`;
    const state = await store.getState(id);
    let { lastSeq = 0, pending } = state;
    if (!pending) {
      const docs = await store.grantLogAfter(chainKey, lastSeq, BATCH);
      if (!docs.length) {
        return 0;
      }
      const fromSeq = lastSeq + 1;
      const toSeq = docs[docs.length - 1].seq;
      pending = {
        fromSeq,
        toSeq,
        until: lockUntil(),
        name: `grant-log/${safe(chainKey)}/${datePath(docs[0].createdAt)}/${pad(fromSeq)}-${pad(toSeq)}.ndjson`,
      };
      await store.setState(id, { lastSeq, pending });
    }

    const docs = await store.grantLogBetween(chainKey, pending.fromSeq, pending.toSeq);
    const exportedAt = new Date(now()).toISOString();
    const gaps = missingRanges(
      pending.fromSeq,
      pending.toSeq,
      docs.map((doc) => doc.seq),
    );
    if (gaps.length) {
      logger.error(
        `[auditExport] grant log ${chainKey} sequence numbers missing: ${gaps.join(', ')}`,
      );
    }
    const records = docs.map((doc) => grantLogRecord(doc, exportedAt));
    records.push({
      recordType: 'batch',
      source: 'grantLog',
      chainKey,
      fromSeq: pending.fromSeq,
      toSeq: pending.toSeq,
      count: docs.length,
      gaps: gaps.join(',') || null,
      exportedAt,
    });
    await upload(pending.name, records, pending.until);
    await store.setState(id, { lastSeq: pending.toSeq }, { pending: '' });
    return docs.length;
  }

  /** Removes MongoDB's copies on the same schedule as the files; after the agreement's end, all of them. */
  async function purge() {
    const ended = now() >= config.retainUntil;
    if (ended) {
      await store.deleteAllEvents();
    }
    for (const chainKey of await store.grantLogChains()) {
      const state = await store.getState(`${store.GRANT_LOG}:${chainKey}`);
      const firstUnexported = await store.grantLogAfter(chainKey, state.lastSeq ?? 0, 1);
      const cutoff = ended ? now() : now() - config.retentionDays * DAY_MS;
      const limit =
        firstUnexported[0] && !ended ? new Date(firstUnexported[0].createdAt).getTime() : cutoff;
      const tenantId = chainKey.startsWith('tenant:')
        ? chainKey.slice('tenant:'.length)
        : undefined;
      await runAsSystem(() =>
        purgeGrantLog(tenantId, { before: new Date(Math.min(cutoff, limit)), confirm: true }),
      );
    }
  }

  async function runOnce() {
    if (!(await store.acquireLease(holder, config.intervalMs * 2, new Date(now())))) {
      return { skipped: true };
    }
    let exported = 0;
    if (now() < config.retainUntil) {
      for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
        const count = await exportAdminRequests();
        exported += count;
        if (!count) {
          break;
        }
      }
      for (const chainKey of await store.grantLogChains()) {
        for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
          const count = await exportGrantLog(chainKey);
          exported += count;
          if (!count) {
            break;
          }
        }
      }
    }
    await purge();
    if (exported) {
      logger.info(`[auditExport] exported ${exported} audit records to gs://${config.bucket}`);
    }
    return { exported };
  }

  return { runOnce, lockUntil, purge };
}

/** Starts the recurring export. Inert unless AUDIT_EXPORT_BUCKET is set. */
function startAuditExport({ env = process.env } = {}) {
  const config = exportConfig(env);
  if (!config) {
    return null;
  }
  const exporter = createExporter({ config });
  let running = false;
  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await defaultStore.ensureIndexes();
      await exporter.runOnce();
    } catch (error) {
      logger.error('[auditExport] export run failed:', error);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 30_000).unref?.();
  const interval = setInterval(run, config.intervalMs);
  interval.unref?.();
  return interval;
}

module.exports = { createExporter, exportConfig, startAuditExport, missingRanges };
