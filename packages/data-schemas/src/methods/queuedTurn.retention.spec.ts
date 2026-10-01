import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type {
  IAgentQueuedTurn,
  IAgentQueuedTurnDocument,
  IAgentQueuedTurnSequenceDocument,
} from '~/types/queuedTurn';
import type { AgentQueuedTurnMethods, EnqueueAgentQueuedTurnInput } from './queuedTurn';
import {
  createAgentQueuedTurnModel,
  createAgentQueuedTurnSequenceModel,
} from '~/models/queuedTurn';
import { getWeeklyReset, nextWeeklyReset } from '~/utils/weeklyRetention';
import { applyWeeklyRetention } from '~/models/plugins/weeklyRetention';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { createAgentQueuedTurnMethods } from './queuedTurn';
import queuedTurnSchema from '~/schema/queuedTurn';

const DB_SETUP_TIMEOUT_MS = 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const BERLIN = 'Europe/Berlin';
const originalEnv = { ...process.env };

let mongoServer: MongoMemoryServer;
let Turn: Model<IAgentQueuedTurnDocument>;
let Sequence: Model<IAgentQueuedTurnSequenceDocument>;
let methods: AgentQueuedTurnMethods;
let user: mongoose.Types.ObjectId;
let counter = 0;

/** The persisted row, including the field the retention plugin owns. */
interface StoredTurn {
  _id: mongoose.Types.ObjectId;
  expiredAt?: Date;
}

beforeAll(async () => {
  /* A one-second TTL pass lets the spec watch MongoDB delete an expired row. */
  mongoServer = await MongoMemoryServer.create({
    instance: { args: ['--setParameter', 'ttlMonitorSleepSecs=1'] },
  });
  await mongoose.connect(mongoServer.getUri());
  Turn = createAgentQueuedTurnModel(mongoose);
  Sequence = createAgentQueuedTurnSequenceModel(mongoose);
  methods = createAgentQueuedTurnMethods(mongoose);
  await methods.ensureAgentQueuedTurnIndexes();
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  process.env = originalEnv;
  await mongoose.disconnect();
  await mongoServer.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all([Turn.deleteMany({}), Sequence.deleteMany({})]);
  user = new mongoose.Types.ObjectId();
  counter += 1;
  useWeeklyReset(true);
});

function useWeeklyReset(enabled: boolean): void {
  if (enabled) {
    process.env.RETENTION_WEEKLY_RESET = 'SUN 23:00';
    process.env.RETENTION_WEEKLY_RESET_TZ = BERLIN;
    return;
  }
  delete process.env.RETENTION_WEEKLY_RESET;
  delete process.env.RETENTION_WEEKLY_RESET_TZ;
}

function currentBoundary(): Date {
  const reset = getWeeklyReset();
  if (reset == null) {
    throw new Error('The spec expects RETENTION_WEEKLY_RESET to be set');
  }
  return nextWeeklyReset(reset);
}

/** Weekday and wall-clock time of an instant in Berlin. */
function berlinClock(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BERLIN,
    hourCycle: 'h23',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
  return `${part('weekday')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

/** The expiry a row written at or after `writtenFrom` must carry. */
function expectWeeklyBoundary(expiredAt: Date | undefined, writtenFrom: Date): void {
  expect(expiredAt).toBeInstanceOf(Date);
  const reset = getWeeklyReset();
  if (!(expiredAt instanceof Date) || reset == null) {
    throw new Error('Expected a weekly boundary on the stored row');
  }
  const candidates = [nextWeeklyReset(reset, writtenFrom), nextWeeklyReset(reset, new Date())];
  expect(candidates.map((boundary) => boundary.getTime())).toContain(expiredAt.getTime());
  expect(berlinClock(expiredAt)).toBe('Sunday 23:00:00');
  expect(expiredAt.getTime()).toBeGreaterThan(writtenFrom.getTime());
  expect(expiredAt.getTime() - writtenFrom.getTime()).toBeLessThanOrEqual(WEEK_MS);
}

async function storedTurns(): Promise<StoredTurn[]> {
  return Turn.find({}).lean<StoredTurn[]>();
}

async function storedTurn(queuedTurnId: string): Promise<StoredTurn | null> {
  return Turn.findById(queuedTurnId).lean<StoredTurn>();
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the TTL monitor');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** A complete row for the model-level write paths. */
function rawTurn(clientRequestId: string): IAgentQueuedTurn {
  return {
    user,
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    parentMessageId: 'parent-1',
    clientRequestId,
    fingerprint: 'f'.repeat(43),
    laneId: 'lane-1',
    status: 'queued',
    priority: false,
    text: 'synthetic follow-up',
    attempts: 0,
    availableAt: new Date(),
  };
}

function enqueueInput(
  overrides: Partial<EnqueueAgentQueuedTurnInput> = {},
): EnqueueAgentQueuedTurnInput {
  return {
    user,
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    parentMessageId: 'parent-1',
    clientRequestId: `request-${counter}`,
    text: 'synthetic follow-up',
    availableAt: new Date(),
    ...overrides,
  };
}

describe('queued turn weekly retention', () => {
  describe('enqueueAgentQueuedTurn', () => {
    it('stamps a turn with the next Sunday 23:00 Berlin boundary', async () => {
      const writtenFrom = new Date();
      const { turn } = await methods.enqueueAgentQueuedTurn(enqueueInput());

      expect(turn.status).toBe('queued');
      expectWeeklyBoundary((await storedTurn(turn.queuedTurnId))?.expiredAt, writtenFrom);
    });

    it('stamps an approval-bearing turn created under its reserved id', async () => {
      const writtenFrom = new Date();
      const queuedTurnId = new mongoose.Types.ObjectId().toString();
      const { turn } = await methods.enqueueAgentQueuedTurn(
        enqueueInput({
          codeApprovalMode: 'ask',
          deliveryReservation: { queuedTurnId, deliveryKey: 'v2-key' },
        }),
      );

      expect(turn.queuedTurnId).toBe(queuedTurnId);
      expectWeeklyBoundary((await storedTurn(queuedTurnId))?.expiredAt, writtenFrom);
    });

    it('keeps the expiry through a replay and the whole delivery lifecycle', async () => {
      const input = enqueueInput();
      const { turn } = await methods.enqueueAgentQueuedTurn(input);
      /* An expiry just short of the boundary shows any write that recomputes it. */
      const pinned = new Date(currentBoundary().getTime() - 1);
      await Turn.updateOne({ _id: turn.queuedTurnId }, { $set: { expiredAt: pinned } });
      const scope = {
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: turn.queuedTurnId,
      };
      const claim = { ...scope, claimId: 'claim-1', claimBy: 'worker-1' };
      const now = new Date();

      expect((await methods.enqueueAgentQueuedTurn(input)).replayed).toBe(true);
      await methods.reserveAgentQueuedTurnDelivery({ ...scope, deliveryKey: 'delivery-1' });
      await methods.markQueuedTurnScheduled({ ...scope, deliveryKey: 'delivery-1' });
      await expect(
        methods.claimNextAgentQueuedTurn({
          ...claim,
          now,
          leaseUntil: new Date(now.getTime() + 60_000),
        }),
      ).resolves.toMatchObject({ outcome: 'acquired' });
      await expect(
        methods.releaseAgentQueuedTurn({ ...claim, disposition: 'retry', availableAt: now }),
      ).resolves.toMatchObject({ outcome: 'released' });
      await expect(methods.cancelAgentQueuedTurn(scope)).resolves.toMatchObject({
        outcome: 'cancelled',
      });

      expect((await storedTurn(turn.queuedTurnId))?.expiredAt).toEqual(pinned);
    });
  });

  describe('every Mongoose path that inserts a row', () => {
    it('stamps create, save and insertMany, lean inserts included', async () => {
      const writtenFrom = new Date();
      await Turn.create(rawTurn('create'));
      await Turn.create([rawTurn('create-array-1'), rawTurn('create-array-2')]);
      await new Turn(rawTurn('save')).save();
      await Turn.insertMany([rawTurn('insert-many')]);
      await Turn.insertMany([rawTurn('insert-many-lean')], { lean: true });

      const rows = await storedTurns();
      expect(rows).toHaveLength(6);
      rows.forEach((row) => expectWeeklyBoundary(row.expiredAt, writtenFrom));
    });

    it('stamps bulk inserts, upserts and replacements', async () => {
      const writtenFrom = new Date();
      await tenantSafeBulkWrite(Turn, [
        { insertOne: { document: rawTurn('bulk-insert') } },
        {
          updateOne: {
            filter: { user, clientRequestId: 'bulk-update-one' },
            update: { $set: { text: 'synthetic follow-up' } },
            upsert: true,
          },
        },
        {
          updateMany: {
            filter: { user, clientRequestId: 'bulk-update-many' },
            update: [{ $set: { text: 'synthetic follow-up' } }],
            upsert: true,
          },
        },
        {
          replaceOne: {
            filter: { user, clientRequestId: 'bulk-replace' },
            replacement: rawTurn('bulk-replace'),
            upsert: true,
          },
        },
      ]);

      const rows = await storedTurns();
      expect(rows).toHaveLength(4);
      rows.forEach((row) => expectWeeklyBoundary(row.expiredAt, writtenFrom));
    });

    it('stamps query upserts, pipeline and replacement upserts included', async () => {
      const writtenFrom = new Date();
      const text = 'synthetic follow-up';
      await Turn.updateOne(
        { user, clientRequestId: 'update-one' },
        { $set: { text } },
        { upsert: true },
      );
      await Turn.updateMany({ user, clientRequestId: 'update-many' }, { text }, { upsert: true });
      await Turn.findOneAndUpdate(
        { user, clientRequestId: 'find-one-and-update' },
        { $setOnInsert: { text } },
        { upsert: true, new: true },
      );
      await Turn.updateOne({ user, clientRequestId: 'pipeline' }, [{ $set: { text } }], {
        upsert: true,
      });
      await Turn.replaceOne({ user, clientRequestId: 'replace-one' }, rawTurn('replace-one'), {
        upsert: true,
      });
      await Turn.findOneAndReplace(
        { user, clientRequestId: 'find-one-and-replace' },
        rawTurn('find-one-and-replace'),
        { upsert: true },
      );

      const rows = await storedTurns();
      expect(rows).toHaveLength(6);
      rows.forEach((row) => expectWeeklyBoundary(row.expiredAt, writtenFrom));
    });

    it('keeps a replacement from dropping the expiry of an existing row', async () => {
      const writtenFrom = new Date();
      const created = await Turn.create(rawTurn('replaced'));
      const expiredAt = (await storedTurn(created.id))?.expiredAt;
      expectWeeklyBoundary(expiredAt, writtenFrom);

      await Turn.replaceOne({ _id: created._id }, rawTurn('replaced'));
      expect((await storedTurn(created.id))?.expiredAt).toEqual(expiredAt);
      await Turn.findOneAndReplace({ _id: created._id }, rawTurn('replaced'));
      expect((await storedTurn(created.id))?.expiredAt).toEqual(expiredAt);
    });
  });

  describe('writes that name an expiry', () => {
    it('keep an earlier one and pull a later one in to the boundary', async () => {
      const boundary = currentBoundary();
      const earlier = new Date(boundary.getTime() - 1);
      const later = new Date(boundary.getTime() + WEEK_MS);
      const kept = await Turn.create({ ...rawTurn('earlier'), expiredAt: earlier });
      const clamped = await Turn.create({ ...rawTurn('later'), expiredAt: later });

      expect((await storedTurn(kept.id))?.expiredAt).toEqual(earlier);
      expect((await storedTurn(clamped.id))?.expiredAt).toEqual(boundary);

      await Turn.updateOne({ _id: kept._id }, { $set: { expiredAt: later } });
      expect((await storedTurn(kept.id))?.expiredAt).toEqual(boundary);
      await Turn.updateOne({ _id: kept._id }, [{ $set: { expiredAt: later } }]);
      expect((await storedTurn(kept.id))?.expiredAt).toEqual(boundary);
      await Turn.findOneAndUpdate({ _id: clamped._id }, { expiredAt: later });
      expect((await storedTurn(clamped.id))?.expiredAt).toEqual(boundary);
      clamped.set('expiredAt', later);
      await clamped.save();
      expect((await storedTurn(clamped.id))?.expiredAt).toEqual(boundary);

      await Turn.updateOne(
        { user, clientRequestId: 'upsert-later' },
        { $setOnInsert: { expiredAt: later } },
        { upsert: true },
      );
      await tenantSafeBulkWrite(Turn, [
        { insertOne: { document: { ...rawTurn('bulk-later'), expiredAt: later } } },
      ]);
      const inserted = await Turn.find({
        clientRequestId: { $in: ['upsert-later', 'bulk-later'] },
      }).lean<StoredTurn[]>();
      expect(inserted.map((row) => row.expiredAt)).toEqual([boundary, boundary]);
    });

    it('leave the stored expiry alone when they do not name one', async () => {
      const pinned = new Date(currentBoundary().getTime() - 1);
      const created = await Turn.create({ ...rawTurn('untouched'), expiredAt: pinned });
      useWeeklyReset(false);
      const legacy = await Turn.create(rawTurn('legacy'));
      useWeeklyReset(true);

      for (const _id of [created._id, legacy._id]) {
        await Turn.updateOne({ _id }, { $set: { status: 'cancelled' } });
        await Turn.updateMany({ _id }, { $inc: { attempts: 1 } });
        await Turn.findOneAndUpdate({ _id }, { $set: { priority: true } }, { new: true });
        const document = await Turn.findById(_id);
        if (document == null) {
          throw new Error('The row must still exist');
        }
        document.text = 'synthetic edit';
        await document.save();
      }

      expect((await storedTurn(created.id))?.expiredAt).toEqual(pinned);
      expect(await storedTurn(legacy.id)).not.toHaveProperty('expiredAt');
    });
  });

  describe('without RETENTION_WEEKLY_RESET', () => {
    beforeEach(() => useWeeklyReset(false));

    it('writes no expiry on any path', async () => {
      await methods.enqueueAgentQueuedTurn(enqueueInput());
      await Turn.create(rawTurn('create'));
      await Turn.insertMany([rawTurn('insert-many')]);
      await tenantSafeBulkWrite(Turn, [
        { insertOne: { document: rawTurn('bulk-insert') } },
        {
          updateOne: {
            filter: { user, clientRequestId: 'bulk-upsert' },
            update: { $set: { text: 'synthetic follow-up' } },
            upsert: true,
          },
        },
      ]);
      await Turn.updateOne(
        { user, clientRequestId: 'upsert' },
        { $set: { text: 'synthetic follow-up' } },
        { upsert: true },
      );
      await Turn.updateOne(
        { user, clientRequestId: 'pipeline' },
        [{ $set: { text: 'synthetic follow-up' } }],
        { upsert: true },
      );
      await Turn.replaceOne({ user, clientRequestId: 'replace' }, rawTurn('replace'), {
        upsert: true,
      });

      const rows = await storedTurns();
      expect(rows).toHaveLength(8);
      rows.forEach((row) => expect(row).not.toHaveProperty('expiredAt'));
    });
  });

  describe('TTL index', () => {
    it('lets MongoDB delete an expired turn and keep one without an expiry', async () => {
      useWeeklyReset(false);
      const unstamped = await methods.enqueueAgentQueuedTurn(enqueueInput());
      useWeeklyReset(true);
      const expiring = await methods.enqueueAgentQueuedTurn(
        enqueueInput({ clientRequestId: `request-${counter}-expiring` }),
      );
      await Turn.updateOne(
        { _id: expiring.turn.queuedTurnId },
        { $set: { expiredAt: new Date(Date.now() - 1000) } },
      );

      await waitFor(async () => (await storedTurn(expiring.turn.queuedTurnId)) == null);
      const survivor = await storedTurn(unstamped.turn.queuedTurnId);
      expect(survivor).not.toBeNull();
      expect(survivor).not.toHaveProperty('expiredAt');
    }, 30_000);

    it('is built by ensureAgentQueuedTurnIndexes and declared once', async () => {
      expect(await Turn.listIndexes()).toContainEqual(
        expect.objectContaining({ key: { expiredAt: 1 }, expireAfterSeconds: 0 }),
      );

      createAgentQueuedTurnModel(mongoose);
      applyWeeklyRetention(queuedTurnSchema);
      const declared = queuedTurnSchema.indexes().filter(([fields]) => 'expiredAt' in fields);
      expect(declared).toEqual([
        [{ expiredAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
      ]);
    });
  });
});
