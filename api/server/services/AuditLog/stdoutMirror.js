const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

/** Exactly the fields the entry hash covers, so a copy re-verifies without MongoDB. */
function toCopy(doc) {
  const entry = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    schemaVersion: entry.schemaVersion,
    category: entry.category,
    action: entry.action,
    outcome: entry.outcome,
    severity: entry.severity,
    actor: entry.actor,
    target: entry.target,
    metadata: entry.metadata,
    context: entry.context,
    tenantId: entry.tenantId,
    chainKey: entry.chainKey,
    seq: entry.seq,
    prevHash: entry.prevHash,
    hash: entry.hash,
    createdAt: entry.createdAt,
  };
}

/**
 * Prints every recorded audit entry as one JSON line, for the log sink to route off-cluster.
 * The infra repo's sink filter matches `jsonPayload.auditLog`; nesting also keeps GKE from
 * consuming the entry's own `severity` field. Inert unless AUDIT_LOG_STDOUT is set.
 */
function mirrorAuditEntries(
  recordAuditEntry,
  { enabled = isEnabled(process.env.AUDIT_LOG_STDOUT) } = {},
) {
  if (!enabled) {
    return recordAuditEntry;
  }
  return async (input, options) => {
    const doc = await recordAuditEntry(input, options);
    if (doc) {
      try {
        const line = { severity: 'NOTICE', message: `audit ${doc.action}`, auditLog: toCopy(doc) };
        process.stdout.write(`${JSON.stringify(line)}\n`);
      } catch (error) {
        logger.error('[auditLog] failed to print audit entry', error);
      }
    }
    return doc;
  };
}

module.exports = { mirrorAuditEntries };
