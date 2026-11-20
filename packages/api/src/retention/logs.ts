import mongoose from 'mongoose';
import { buildIndexWithRetry } from '@librechat/data-schemas';

/** The collection the Mongo-backed Keyv store (bans, encoded domains) writes to. */
const KEYV_LOGS_COLLECTION = 'logs';

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
  await buildIndexWithRetry(
    () =>
      db.collection(KEYV_LOGS_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    `${KEYV_LOGS_COLLECTION}.expiresAt`,
  );
}
