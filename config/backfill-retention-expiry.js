const path = require('path');
const mongoose = require('mongoose');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { getWeeklyReset, nextWeeklyReset } = require('@librechat/data-schemas');
const { silentExit } = require('./helpers');
const connect = require('./connect');

/**
 * Stamps `expiredAt` on rows written before the retention boundary existed.
 *
 * `expiredAt` is only written when a record is saved, and a TTL index ignores a
 * document whose indexed field is null or absent — so without this, everything
 * already in the database is never deleted, however long it sits there.
 *
 * Dry run by default; pass --apply to write.
 */

/** Contexts that are not patient data and must survive the sweep. */
const KEEP_FILE_CONTEXTS = ['avatar', 'agents', 'skill_file'];

/**
 * Every file id any agent points at, superseded versions included. For files
 * written since `retainAgentFiles` took effect a null `expiredAt` already means
 * "agent resource, keep", but rows predating it are all null — so that test
 * would delete the knowledge bases. This is the authoritative record instead.
 */
async function collectAgentFileIds(db) {
  const ids = new Set();
  const cursor = db
    .collection('agents')
    .find({}, { projection: { tool_resources: 1, versions: 1 } });

  for await (const agent of cursor) {
    const versions = Array.isArray(agent.versions) ? agent.versions : [];
    const allResources = [agent.tool_resources, ...versions.map((v) => v && v.tool_resources)];

    for (const resources of allResources) {
      if (!resources || typeof resources !== 'object') {
        continue;
      }
      for (const entry of Object.values(resources)) {
        if (!entry || !Array.isArray(entry.file_ids)) {
          continue;
        }
        for (const fileId of entry.file_ids) {
          if (typeof fileId === 'string') {
            ids.add(fileId);
          }
        }
      }
    }
  }
  return ids;
}

function buildTargets(agentFileIds) {
  return [
    { label: 'conversations', name: 'conversations', filter: { expiredAt: null } },
    { label: 'messages', name: 'messages', filter: { expiredAt: null } },
    { label: 'shared links', name: 'sharedlinks', filter: { expiredAt: null } },
    {
      label: 'files',
      name: 'files',
      filter: {
        expiredAt: null,
        context: { $nin: KEEP_FILE_CONTEXTS },
        file_id: { $nin: [...agentFileIds] },
      },
    },
  ];
}

const inBerlin = (date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour12: false,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);

async function main() {
  const apply = process.argv.includes('--apply');
  await connect();

  const reset = getWeeklyReset();
  if (!reset) {
    console.red('\nRETENTION_WEEKLY_RESET is not set, so there is no boundary to stamp.');
    console.yellow('Set RETENTION_WEEKLY_RESET (e.g. "SUN 23:00") and RETENTION_WEEKLY_RESET_TZ.');
    silentExit(1);
  }

  const boundary = nextWeeklyReset(reset);
  const db = mongoose.connection.db;

  console.purple('\n---------------------------------------');
  console.purple('Backfill retention expiry');
  console.purple('---------------------------------------');
  console.cyan(`Database:  ${mongoose.connection.name} on ${mongoose.connection.host}`);
  console.cyan(`Boundary:  ${inBerlin(boundary)} Berlin  (${boundary.toISOString()})`);
  console.cyan(`Mode:      ${apply ? 'APPLY — rows will be written' : 'dry run'}\n`);

  const agentFileIds = await collectAgentFileIds(db);
  console.green(`Protected agent files: ${agentFileIds.size}`);

  const targets = buildTargets(agentFileIds);
  let total = 0;

  for (const target of targets) {
    target.count = await db.collection(target.name).countDocuments(target.filter);
    total += target.count;
    console.cyan(`  ${target.label.padEnd(14)} ${target.count}`);
  }

  if (total === 0) {
    console.green('\nNothing to backfill — every row already carries an expiry.');
    silentExit(0);
  }

  if (!apply) {
    console.yellow(`\n${total} rows would be stamped. Re-run with --apply to write them.`);
    silentExit(0);
  }

  console.purple('\nApplying...');
  for (const target of targets) {
    if (target.count === 0) {
      continue;
    }
    const result = await db
      .collection(target.name)
      .updateMany(target.filter, { $set: { expiredAt: boundary } });
    console.green(`  ${target.label.padEnd(14)} ${result.modifiedCount} stamped`);
  }

  console.purple('\nVerifying...');
  let remaining = 0;
  for (const target of targets) {
    const left = await db.collection(target.name).countDocuments(target.filter);
    remaining += left;
    console.cyan(`  ${target.label.padEnd(14)} ${left} left unstamped`);
  }

  if (remaining > 0) {
    console.orange(
      `\n${remaining} rows still unstamped — rows written during the run pick up the boundary themselves.`,
    );
  }
  console.green(`\nDone. These rows are deleted at ${inBerlin(boundary)} Berlin.`);
  silentExit(0);
}

if (require.main === module) {
  main();

  process.on('uncaughtException', (err) => {
    console.error('There was an uncaught error:');
    console.error(err);
    process.exit(1);
  });
}

module.exports = { collectAgentFileIds, buildTargets, KEEP_FILE_CONTEXTS };
