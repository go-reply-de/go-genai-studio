const mongoose = require('mongoose');

/** Admin change requests, recorded before they run and exported to the locked audit bucket. */
const EVENTS = 'adminauditevents';
/** Upstream's hash-chained grant log. */
const GRANT_LOG = 'auditlogs';
const COUNTERS = 'auditcounters';
const STATE = 'auditexportstate';

const collection = (name) => mongoose.connection.collection(name);

/** The driver returns the document itself from v6 on, wrapped in { value } before. */
const unwrap = (result) =>
  result && result.value !== undefined && result.ok !== undefined ? result.value : result;

async function ensureIndexes() {
  const events = collection(EVENTS);
  await events.createIndex({ seq: 1 }, { unique: true });
  // Set at export to the file's delete date, so MongoDB's copy goes at the same moment.
  await events.createIndex({ deleteAt: 1 }, { expireAfterSeconds: 0 });
}

async function nextSeq() {
  const doc = unwrap(
    await collection(COUNTERS).findOneAndUpdate(
      { _id: EVENTS },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    ),
  );
  return doc.seq;
}

const recordStart = (event) => collection(EVENTS).insertOne(event);

const recordEnd = (id, fields) => collection(EVENTS).updateOne({ _id: id }, { $set: fields });

const eventsBetween = (fromSeq, toSeq) =>
  collection(EVENTS)
    .find({ seq: { $gte: fromSeq, $lte: toSeq } })
    .sort({ seq: 1 })
    .toArray();

const eventsAfter = (seq, limit) =>
  collection(EVENTS)
    .find({ seq: { $gt: seq } })
    .sort({ seq: 1 })
    .limit(limit)
    .toArray();

const markExported = (fromSeq, toSeq, fields) =>
  collection(EVENTS).updateMany({ seq: { $gte: fromSeq, $lte: toSeq } }, { $set: fields });

/** Everything still in MongoDB once the retention period has ended, exported or not. */
const deleteAllEvents = () => collection(EVENTS).deleteMany({});

const grantLogChains = () => collection(GRANT_LOG).distinct('chainKey');

const grantLogAfter = (chainKey, seq, limit) =>
  collection(GRANT_LOG)
    .find({ chainKey, seq: { $gt: seq } })
    .sort({ seq: 1 })
    .limit(limit)
    .toArray();

const grantLogBetween = (chainKey, fromSeq, toSeq) =>
  collection(GRANT_LOG)
    .find({ chainKey, seq: { $gte: fromSeq, $lte: toSeq } })
    .sort({ seq: 1 })
    .toArray();

const getState = async (id) =>
  (await collection(STATE).findOne({ _id: id })) ?? { _id: id, lastSeq: 0 };

const setState = (id, fields, unset) =>
  collection(STATE).updateOne(
    { _id: id },
    { $set: fields, ...(unset ? { $unset: unset } : {}) },
    { upsert: true },
  );

/** Only one api replica exports at a time; a holder that dies loses the lease when it expires. */
async function acquireLease(holder, ms, now = new Date()) {
  try {
    await collection(STATE).findOneAndUpdate(
      { _id: 'lease', $or: [{ until: { $lt: now } }, { holder }] },
      { $set: { holder, until: new Date(now.getTime() + ms) } },
      { upsert: true },
    );
    return true;
  } catch (error) {
    if (error?.code === 11000) {
      return false;
    }
    throw error;
  }
}

module.exports = {
  EVENTS,
  GRANT_LOG,
  ensureIndexes,
  nextSeq,
  recordStart,
  recordEnd,
  eventsBetween,
  eventsAfter,
  markExported,
  deleteAllEvents,
  grantLogChains,
  grantLogAfter,
  grantLogBetween,
  getState,
  setState,
  acquireLease,
};
