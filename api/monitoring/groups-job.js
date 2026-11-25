/**
 * Hourly job (k8s/monitoring-groups.yaml): counts each user's conversations and tokens of the
 * running week from LibreChat's token records, groups the users (groups.js) and replaces the week's
 * rows in BigQuery. The per-user counts stay in this process's memory; no user id or count per
 * user is stored or logged.
 */
const { MongoClient } = require('mongodb');
const { createGoogle } = require('./google');
const { groupWeek } = require('./groups');

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const RESET_PATTERN = /^([A-Za-z]{3})\s+([01]?\d|2[0-3]):([0-5]\d)$/;
/** Without a weekly reset, weeks are calendar weeks in Berlin. */
const MONDAY = { day: 1, hour: 0, minute: 0, timeZone: 'Europe/Berlin' };
const DAY_MS = 24 * 3600e3;

function log(severity, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ severity, message, ...fields })}\n`);
}

/**
 * RETENTION_WEEKLY_RESET ("SUN 23:00") and its zone, read as LibreChat reads them: null when unset
 * or unusable, UTC when no zone is given. Kept here because LibreChat's package opens log files
 * when it loads, which this read-only container cannot.
 */
function parseReset(value, timeZone) {
  const match = RESET_PATTERN.exec(String(value ?? '').trim());
  const day = match ? DAY_NAMES.indexOf(match[1].toUpperCase()) : -1;
  if (day < 0) {
    return null;
  }
  const zone = String(timeZone ?? '').trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    return null;
  }
  return { day, hour: Number(match[2]), minute: Number(match[3]), timeZone: zone };
}

const formats = new Map();

/** The wall-clock date and time of `ms` in `timeZone`. */
function partsOf(ms, timeZone) {
  if (!formats.has(timeZone)) {
    formats.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }),
    );
  }
  const parts = formats.get(timeZone).formatToParts(new Date(ms));
  return Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
}

function offsetOf(ms, timeZone) {
  const p = partsOf(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time names; the offset is checked again across a clock change. */
function fromZoned(year, month, day, hour, minute, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const guess = offsetOf(naive, timeZone);
  const corrected = offsetOf(naive - guess, timeZone);
  return new Date(naive - corrected);
}

/**
 * The week `now` falls in: from the last weekly reset to the next, so a week ends exactly when
 * its chats are deleted. Named by the Monday of the calendar week that holds most of its days.
 */
function weekOf(now, reset) {
  const r = reset || MONDAY;
  const here = partsOf(now.getTime(), r.timeZone);
  const weekday = new Date(Date.UTC(here.year, here.month - 1, here.day)).getUTCDay();
  let day = here.day - ((weekday - r.day + 7) % 7);
  let start = fromZoned(here.year, here.month, day, r.hour, r.minute, r.timeZone);
  if (start > now) {
    day -= 7;
    start = fromZoned(here.year, here.month, day, r.hour, r.minute, r.timeZone);
  }
  const end = fromZoned(here.year, here.month, day + 7, r.hour, r.minute, r.timeZone);
  const middle = new Date(Date.UTC(here.year, here.month - 1, day + 3));
  const monday = new Date(middle.getTime() - ((middle.getUTCDay() + 6) % 7) * DAY_MS);
  return { start, end, week: monday.toISOString().slice(0, 10) };
}

/**
 * Each user's conversations with a model call in the week and their prompt and completion tokens,
 * from the token records, which stay when a user deletes a chat. The user ids never leave MongoDB;
 * users without a conversation in the week are left out.
 */
async function countWeek(db, start, end) {
  return db
    .collection('transactions')
    .aggregate([
      {
        $match: {
          createdAt: { $gte: start, $lt: end },
          tokenType: { $in: ['prompt', 'completion'] },
        },
      },
      {
        $group: {
          _id: '$user',
          ids: { $addToSet: '$conversationId' },
          tokens: { $sum: { $abs: { $ifNull: ['$rawAmount', 0] } } },
        },
      },
      {
        $project: {
          _id: 0,
          conversations: { $size: { $setDifference: ['$ids', [null, '']] } },
          tokens: 1,
        },
      },
      { $match: { conversations: { $gt: 0 } } },
    ])
    .toArray();
}

const int = (value) => ({ type: 'INT64', value: String(value) });

/** Replaces the week's rows with `rows` in one statement, so the page never sees half a week. */
async function writeWeek({ query, table }, week, rows) {
  const params = { week: { type: 'DATE', value: week } };
  const selects = rows.map((row, i) => {
    params[`min${i}`] = int(row.min);
    if (row.max !== null) {
      params[`max${i}`] = int(row.max);
    }
    params[`users${i}`] = int(row.users);
    params[`conversations${i}`] = int(row.conversationsShare);
    params[`tokens${i}`] = int(row.tokensShare);
    const max = row.max === null ? 'CAST(NULL AS INT64)' : `@max${i}`;
    return (
      `SELECT @week AS week, @min${i} AS min_conversations, ${max} AS max_conversations, ` +
      `@users${i} AS users, @conversations${i} AS conversations_share, @tokens${i} AS tokens_share`
    );
  });
  const columns =
    'week, min_conversations, max_conversations, users, conversations_share, tokens_share';
  const sql = `MERGE ${await table('usage_groups')} T
USING (${selects.join(' UNION ALL ')}) S
ON T.week = S.week AND T.min_conversations = S.min_conversations
WHEN MATCHED THEN UPDATE SET max_conversations = S.max_conversations, users = S.users,
  conversations_share = S.conversations_share, tokens_share = S.tokens_share
WHEN NOT MATCHED THEN INSERT (${columns}) VALUES (${columns
    .split(', ')
    .map((c) => `S.${c}`)
    .join(', ')})
WHEN NOT MATCHED BY SOURCE AND T.week = @week THEN DELETE`;
  return query(sql, params);
}

async function runJob({ db, google, reset, now = () => new Date(), log: write = log }) {
  const { start, end, week } = weekOf(now(), reset);
  const rows = groupWeek(await countWeek(db, start, end));
  await writeWeek(google, week, rows);
  write('INFO', 'usage groups written', { week, rows: rows.length });
}

async function main(env = process.env) {
  const client = await MongoClient.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  try {
    await runJob({
      db: client.db(),
      google: createGoogle({ dataset: env.FEEDBACK_DATASET?.trim() || 'feedback' }),
      reset: parseReset(env.RETENTION_WEEKLY_RESET, env.RETENTION_WEEKLY_RESET_TZ),
    });
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    log('ERROR', 'usage groups failed', { detail: error.message });
    process.exitCode = 1;
  });
}

module.exports = { parseReset, weekOf, countWeek, writeWeek, runJob };
