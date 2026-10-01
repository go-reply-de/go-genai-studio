const mongoose = require('mongoose');
const { MeiliSearch } = require('meilisearch');
const { logger, runAsSystem, buildRetentionVisibilityFilter } = require('@librechat/data-schemas');

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DELETE_TASK_TIMEOUT_MS = 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;

/** The two Meili indexes that hold conversation text, paired with their Mongo model. */
const SWEPT_INDEXES = [
  { indexName: 'convos', primaryKey: 'conversationId', modelName: 'Conversation' },
  { indexName: 'messages', primaryKey: 'messageId', modelName: 'Message' },
];

const isSearchEnabled = () => process.env.SEARCH?.toLowerCase() === 'true';

const isMeiliConfigured = () =>
  process.env.MEILI_HOST != null && process.env.MEILI_MASTER_KEY != null;

const isIndexNotFound = (error) =>
  error?.code === 'index_not_found' || error?.cause?.code === 'index_not_found';

/**
 * @param {string} [raw] - Raw interval value, defaults to the env var.
 * @returns {number} Sweep interval in ms; 0 disables the sweep.
 */
function getMeiliRetentionSweepInterval(raw = process.env.MEILI_RETENTION_SWEEP_INTERVAL_MS) {
  if (raw == null || raw.trim() === '') {
    return DEFAULT_SWEEP_INTERVAL_MS;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (value > 0 && value < 1)) {
    logger.warn(
      `[meiliRetentionSweep] Invalid MEILI_RETENTION_SWEEP_INTERVAL_MS: ${raw}. Using default: ${DEFAULT_SWEEP_INTERVAL_MS}ms.`,
    );
    return DEFAULT_SWEEP_INTERVAL_MS;
  }
  return value;
}

function getBatchSize() {
  const value = parseInt(process.env.MEILI_SYNC_BATCH_SIZE || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BATCH_SIZE;
}

/**
 * Deletes every document in one Meili index that Mongo retention no longer keeps.
 *
 * Mongo TTL indexes reap expired conversations and messages server-side, which
 * bypasses the mongoose hooks that normally prune Meili, so the indexed `text`
 * and `content` outlive the retention window unless swept here.
 *
 * @param {object} params
 * @param {import('meilisearch').Index} params.index
 * @param {import('mongoose').Model} params.model
 * @param {string} params.primaryKey
 * @param {number} params.batchSize
 * @returns {Promise<{ scanned: number, deleted: number }>}
 */
async function sweepIndex({ index, model, primaryKey, batchSize }) {
  let offset = 0;
  let scanned = 0;
  let deleted = 0;
  let pagesRemaining = Number.POSITIVE_INFINITY;

  while (pagesRemaining > 0) {
    const batch = await index.getDocuments({ limit: batchSize, offset, fields: [primaryKey] });

    if (pagesRemaining === Number.POSITIVE_INFINITY) {
      // Bound the walk by the index size observed on the first page, so concurrent
      // writes can never turn this into an unbounded loop.
      pagesRemaining = Math.ceil((batch.total ?? 0) / batchSize) + 2;
    }
    pagesRemaining--;

    const meiliIds = batch.results.map((doc) => doc[primaryKey]).filter((id) => id != null);
    if (meiliIds.length === 0) {
      break;
    }
    scanned += meiliIds.length;

    /* The same filter the indexer uses, so a document is treated as live only while
     * retention still keeps it visible - an elapsed `expiredAt` reads as orphaned even
     * in the minute before the TTL monitor removes the row. */
    const live = await model
      .find({ [primaryKey]: { $in: meiliIds }, ...buildRetentionVisibilityFilter() })
      .select(primaryKey)
      .lean();
    const liveIds = new Set(live.map((doc) => doc[primaryKey]));
    const orphaned = meiliIds.filter((id) => !liveIds.has(id));

    if (orphaned.length > 0) {
      const task = await index.deleteDocuments(orphaned.map(String));
      // Deletion is queued, and the next page's offset is only correct once it lands.
      await index.waitForTask(task.taskUid, { timeOutMs: DELETE_TASK_TIMEOUT_MS });
      deleted += orphaned.length;
    }

    if (batch.results.length < batchSize) {
      break;
    }
    offset += batchSize - orphaned.length;
  }

  return { scanned, deleted };
}

/**
 * Sweeps both text-bearing Meili indexes once.
 *
 * @returns {Promise<Record<string, { scanned: number, deleted: number }> | null>}
 */
async function sweepOrphanedMeiliDocuments() {
  if (!isSearchEnabled() || !isMeiliConfigured()) {
    return null;
  }

  const client = new MeiliSearch({
    host: process.env.MEILI_HOST,
    apiKey: process.env.MEILI_MASTER_KEY,
  });

  const { status } = await client.health();
  if (status !== 'available') {
    logger.warn(`[meiliRetentionSweep] Meilisearch status "${status}", skipping sweep`);
    return null;
  }

  const batchSize = getBatchSize();
  const results = {};

  for (const { indexName, primaryKey, modelName } of SWEPT_INDEXES) {
    const model = mongoose.models[modelName];
    if (!model) {
      logger.warn(
        `[meiliRetentionSweep] Model ${modelName} not registered, skipping ${indexName} index`,
      );
      continue;
    }

    try {
      results[indexName] = await sweepIndex({
        index: client.index(indexName),
        model,
        primaryKey,
        batchSize,
      });
    } catch (error) {
      if (isIndexNotFound(error)) {
        logger.debug(`[meiliRetentionSweep] Index ${indexName} does not exist yet, skipping`);
        continue;
      }
      logger.error(`[meiliRetentionSweep] Error sweeping ${indexName} index:`, error);
    }
  }

  const totalDeleted = Object.values(results).reduce((sum, r) => sum + r.deleted, 0);
  if (totalDeleted > 0) {
    const summary = Object.entries(results)
      .map(([name, r]) => `${name}: ${r.deleted}/${r.scanned}`)
      .join(', ');
    logger.info(`[meiliRetentionSweep] Deleted ${totalDeleted} expired documents (${summary})`);
  }

  return results;
}

/**
 * Starts the recurring sweep. Runs once immediately so a restart does not leave
 * expired documents searchable for a further interval.
 *
 * @returns {NodeJS.Timeout | null}
 */
function startMeiliRetentionSweep() {
  if (!isSearchEnabled() || !isMeiliConfigured()) {
    return null;
  }

  const intervalMs = getMeiliRetentionSweepInterval();
  if (intervalMs === 0) {
    logger.info('[meiliRetentionSweep] Disabled by MEILI_RETENTION_SWEEP_INTERVAL_MS=0');
    return null;
  }

  let isSweeping = false;
  const runSweep = async () => {
    if (isSweeping) {
      return;
    }

    isSweeping = true;
    try {
      // Both models are tenant-isolated; the sweep spans every tenant.
      await runAsSystem(sweepOrphanedMeiliDocuments);
    } catch (error) {
      logger.error('[meiliRetentionSweep] Background sweep failed:', error);
    } finally {
      isSweeping = false;
    }
  };

  runSweep();
  const interval = setInterval(runSweep, intervalMs);
  interval.unref?.();
  return interval;
}

module.exports = {
  sweepIndex,
  sweepOrphanedMeiliDocuments,
  startMeiliRetentionSweep,
  getMeiliRetentionSweepInterval,
};
