import mongoose from 'mongoose';

/** The collection the Mongo-backed Keyv store (bans, encoded domains) writes to. */
const KEYV_LOGS_COLLECTION = 'logs';
/** A busy collection can refuse an index build for a moment, so try a few times. */
const INDEX_BUILD_ATTEMPTS = 3;
const INDEX_RETRY_DELAY_MS = 2000;

/**
 * The Keyv store writes `expiresAt` but only drops an entry when it is read past it, so a ban
 * keyed by user id or IP that is never read again would stay. Entries without a TTL hold null,
 * which the index ignores.
 */
export async function ensureLogsExpiryIndex(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) {
    throw new Error('MongoDB is not connected');
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await db
        .collection(KEYV_LOGS_COLLECTION)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      return;
    } catch (error) {
      if (attempt >= INDEX_BUILD_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, INDEX_RETRY_DELAY_MS * attempt));
    }
  }
}
