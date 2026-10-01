import type { AnyBulkWriteOperation, Schema } from 'mongoose';
import type { WeeklyReset } from '~/utils/weeklyRetention';
import { getWeeklyReset, nextWeeklyReset } from '~/utils/weeklyRetention';

type Fields = Record<string, unknown>;

const applied = new WeakSet<Schema>();

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null;
}

/** An earlier expiry stands; a missing or later one is pulled in to the boundary. */
function stamp(target: unknown, boundary: Date): void {
  if (!isFields(target)) {
    return;
  }
  const current = target.expiredAt;
  if (!(current instanceof Date) || current.getTime() > boundary.getTime()) {
    target.expiredAt = boundary;
  }
}

/** Where an update writes `expiredAt`; an upsert that writes none gets it on insert. */
function expiryTarget(update: Fields, upsert: boolean): Fields | null {
  if ('expiredAt' in update) {
    return update;
  }
  if (isFields(update.$set) && 'expiredAt' in update.$set) {
    return update.$set;
  }
  if (!upsert) {
    return null;
  }
  const onInsert: Fields = isFields(update.$setOnInsert) ? update.$setOnInsert : {};
  update.$setOnInsert = onInsert;
  return onInsert;
}

/**
 * A pipeline computes whole rows, so a final stage bounds whatever row it produces.
 * `$addFields` rather than its `$set` alias, which DocumentDB rejects as a stage.
 */
function stampUpdate(update: unknown, upsert: boolean, reset: WeeklyReset): void {
  if (Array.isArray(update)) {
    const boundary = nextWeeklyReset(reset);
    update.push({
      $addFields: { expiredAt: { $min: [{ $ifNull: ['$expiredAt', boundary] }, boundary] } },
    });
    return;
  }
  const target = isFields(update) ? expiryTarget(update, upsert) : null;
  if (target != null) {
    stamp(target, nextWeeklyReset(reset));
  }
}

function stampBulkWrite(op: AnyBulkWriteOperation, reset: WeeklyReset): void {
  if ('insertOne' in op) {
    stamp(op.insertOne.document, nextWeeklyReset(reset));
  } else if ('replaceOne' in op) {
    stamp(op.replaceOne.replacement, nextWeeklyReset(reset));
  } else if ('updateOne' in op) {
    stampUpdate(op.updateOne.update, op.updateOne.upsert === true, reset);
  } else if ('updateMany' in op) {
    stampUpdate(op.updateMany.update, op.updateMany.upsert === true, reset);
  }
}

/**
 * Stamps the RETENTION_WEEKLY_RESET boundary on `expiredAt` for the TTL index on every write
 * that can insert a row, and keeps any write from moving it later. Unset, nothing is stamped.
 */
export function applyWeeklyRetention(schema: Schema): void {
  if (applied.has(schema)) {
    return;
  }
  applied.add(schema);

  schema.add({ expiredAt: { type: Date } });
  schema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });

  schema.pre('save', function () {
    const reset = getWeeklyReset();
    if (reset != null && (this.isNew || this.isModified('expiredAt'))) {
      stamp(this, nextWeeklyReset(reset));
    }
  });

  schema.pre('insertMany', function (next, docs: unknown) {
    const reset = getWeeklyReset();
    if (reset != null) {
      const boundary = nextWeeklyReset(reset);
      for (const doc of Array.isArray(docs) ? docs : [docs]) {
        stamp(doc, boundary);
      }
    }
    next();
  });

  schema.pre('bulkWrite', function (next, ops) {
    const reset = getWeeklyReset();
    if (reset != null) {
      for (const op of ops) {
        stampBulkWrite(op, reset);
      }
    }
    next();
  });

  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
    const reset = getWeeklyReset();
    if (reset != null) {
      stampUpdate(this.getUpdate(), this.getOptions().upsert === true, reset);
    }
  });

  /** A replacement drops every field it omits, the expiry included. */
  schema.pre(['replaceOne', 'findOneAndReplace'], function () {
    const reset = getWeeklyReset();
    if (reset != null) {
      stamp(this.getUpdate(), nextWeeklyReset(reset));
    }
  });
}
