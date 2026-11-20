import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type {
  IAgentTriggerDeliveryDocument,
  IAgentTriggerLaneSequenceDocument,
  AgentTriggerDeliveryRecord,
} from '~/types/triggerDelivery';
import type {
  AgentTriggerDeliveryMethods,
  EnqueueAgentTriggerDeliveryInput,
} from './triggerDelivery';
import {
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
} from '~/types/triggerDelivery';
import { createAgentTriggerLaneSequenceModel } from '~/models/triggerLaneSequence';
import { createAgentTriggerUserPurgeModel } from '~/models/triggerUserPurge';
import { createAgentTriggerDeliveryModel } from '~/models/triggerDelivery';
import { getWeeklyReset, nextWeeklyReset } from '~/utils/weeklyRetention';
import { applyWeeklyRetention } from '~/models/plugins/weeklyRetention';
import { createAgentTriggerDeliveryMethods } from './triggerDelivery';
import triggerDeliverySchema from '~/schema/triggerDelivery';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const SUCCESS_RETENTION_MS = 90 * 24 * 60 * 60_000;
const BERLIN = 'Europe/Berlin';
const originalEnv = { ...process.env };
/* The plugin only shapes schemas built while the reset is configured. */
process.env.RETENTION_WEEKLY_RESET = 'SUN 23:00';
process.env.RETENTION_WEEKLY_RESET_TZ = BERLIN;

let mongoServer: MongoMemoryServer;
let Delivery: Model<IAgentTriggerDeliveryDocument>;
let LaneSequence: Model<IAgentTriggerLaneSequenceDocument>;
let methods: AgentTriggerDeliveryMethods;
let counter = 0;

/** The persisted row, including the field the retention plugin owns. */
interface StoredDelivery {
  _id: mongoose.Types.ObjectId;
  status: string;
  expiredAt?: Date;
  expiresAt?: Date;
}

beforeAll(async () => {
  /* A one-second TTL pass lets the spec watch MongoDB delete an expired row. */
  mongoServer = await MongoMemoryServer.create({
    instance: { args: ['--setParameter', 'ttlMonitorSleepSecs=1'] },
  });
  await mongoose.connect(mongoServer.getUri());
  Delivery = createAgentTriggerDeliveryModel(mongoose);
  LaneSequence = createAgentTriggerLaneSequenceModel(mongoose);
  createAgentTriggerUserPurgeModel(mongoose);
  methods = createAgentTriggerDeliveryMethods(mongoose);
  await methods.ensureAgentTriggerDeliveryIndexes();
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  process.env = originalEnv;
  await mongoose.disconnect();
  await mongoServer.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all([Delivery.deleteMany({}), LaneSequence.deleteMany({})]);
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
  expect(expiredAt.getTime() - writtenFrom.getTime()).toBeLessThanOrEqual(WEEK_MS);
}

async function stored(id: string): Promise<StoredDelivery | null> {
  return Delivery.findById(id).lean<StoredDelivery>();
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

/** A delivery shaped like a queued follow-up turn, with its prompt in the envelope. */
function enqueueInput(
  overrides: Partial<EnqueueAgentTriggerDeliveryInput> = {},
): EnqueueAgentTriggerDeliveryInput {
  return {
    deliveryKey: `retention-${counter}-${Math.random().toString(36).slice(2)}`,
    fingerprint: `fingerprint-${counter}`,
    orderingKey: `retention-lane-${counter}`,
    envelope: { version: 1, mode: 'continue', input: 'synthetic follow-up' },
    user: new mongoose.Types.ObjectId(),
    tenantId: 'tenant-1',
    availableAt: new Date(),
    ...overrides,
  };
}

async function claimAndBegin(
  delivery: AgentTriggerDeliveryRecord,
  worker: string,
): Promise<{ id: string; workerId: string; claimToken: string; attempt: number }> {
  const now = new Date();
  const claim = await methods.claimNextAgentTriggerDelivery({
    workerId: worker,
    claimToken: `${worker}-claim`,
    now,
    leaseUntil: new Date(now.getTime() + 60_000),
  });
  expect(claim?.id).toBe(delivery.id);
  const fence = { id: delivery.id, workerId: worker, claimToken: `${worker}-claim` };
  const attempt = await methods.beginAgentTriggerDeliveryAttempt({ ...fence, now });
  if (attempt == null) {
    throw new Error('The claimed delivery must accept an attempt');
  }
  return { ...fence, attempt };
}

describe('agent trigger delivery weekly retention', () => {
  describe('enqueueAgentTriggerDelivery', () => {
    it('stamps ordinary and capability-fenced deliveries with the next Sunday 23:00 boundary', async () => {
      const writtenFrom = new Date();
      const ordinary = await methods.enqueueAgentTriggerDelivery(enqueueInput());
      const queuedTurn = await methods.enqueueAgentTriggerDelivery(
        enqueueInput({ requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2 }),
      );
      const completion = await methods.enqueueAgentTriggerDelivery(
        enqueueInput({
          requiredWorkerCapability:
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          producerLeaseUntil: new Date(Date.now() + 30_000),
        }),
      );

      const enqueued = [ordinary, queuedTurn, completion];
      expect(enqueued.map(({ replayed }) => replayed)).toEqual([false, false, false]);
      for (const { delivery } of enqueued) {
        expectWeeklyBoundary((await stored(delivery.id))?.expiredAt, writtenFrom);
      }
    });

    it('keeps the boundary through success, beside the 90-day expiresAt', async () => {
      const writtenFrom = new Date();
      const { delivery } = await methods.enqueueAgentTriggerDelivery(enqueueInput());
      const boundary = (await stored(delivery.id))?.expiredAt;
      const fence = await claimAndBegin(delivery, 'worker-success');
      const settledAt = new Date();

      await expect(
        methods.completeAgentTriggerDelivery({ ...fence, result: { ok: true }, settledAt }),
      ).resolves.toBe(true);

      const row = await stored(delivery.id);
      expect(row?.status).toBe('succeeded');
      expect(row?.expiresAt).toEqual(new Date(settledAt.getTime() + SUCCESS_RETENTION_MS));
      expect(row?.expiredAt).toEqual(boundary);
      expectWeeklyBoundary(row?.expiredAt, writtenFrom);
    });

    it('keeps the boundary on a dead letter, which has no expiresAt, and through a requeue', async () => {
      const writtenFrom = new Date();
      const { delivery } = await methods.enqueueAgentTriggerDelivery(enqueueInput());
      const boundary = (await stored(delivery.id))?.expiredAt;
      const fence = await claimAndBegin(delivery, 'worker-dead');

      await methods.deadLetterAgentTriggerDelivery({
        ...fence,
        error: {
          code: 'PERMANENT',
          message: 'synthetic failure',
          certainty: 'definite',
          retryable: false,
          attemptedAt: new Date(),
        },
        settledAt: new Date(),
      });
      const dead = await stored(delivery.id);
      expect(dead?.status).toBe('dead');
      expect(dead).not.toHaveProperty('expiresAt');
      expect(dead?.expiredAt).toEqual(boundary);

      await expect(
        methods.requeueAgentTriggerDelivery(delivery.id, new Date()),
      ).resolves.not.toBeNull();
      expect((await stored(delivery.id))?.expiredAt).toEqual(boundary);
      expectWeeklyBoundary(boundary, writtenFrom);
    });
  });

  describe('a row the TTL monitor removes while it is still live', () => {
    it('settles as a lost lease and stops blocking the rest of its lane', async () => {
      const orderingKey = `live-lane-${counter}`;
      const first = await methods.enqueueAgentTriggerDelivery(enqueueInput({ orderingKey }));
      const second = await methods.enqueueAgentTriggerDelivery(enqueueInput({ orderingKey }));
      const fence = await claimAndBegin(first.delivery, 'worker-boundary');
      await expect(
        methods.findEarlierAgentTriggerDelivery(second.delivery),
      ).resolves.not.toBeNull();

      await Delivery.updateOne(
        { _id: first.delivery.id },
        { $set: { expiredAt: new Date(Date.now() - 1000) } },
      );
      await waitFor(async () => (await stored(first.delivery.id)) == null);

      await expect(
        methods.completeAgentTriggerDelivery({
          ...fence,
          result: { ok: true },
          settledAt: new Date(),
        }),
      ).resolves.toBe(false);
      await expect(methods.findEarlierAgentTriggerDelivery(second.delivery)).resolves.toBeNull();

      const next = await claimAndBegin(second.delivery, 'worker-next');
      await expect(
        methods.completeAgentTriggerDelivery({
          ...next,
          result: { ok: true },
          settledAt: new Date(),
        }),
      ).resolves.toBe(true);
      await methods.reclaimInactiveAgentTriggerLanes();
      await expect(LaneSequence.countDocuments({ _id: orderingKey })).resolves.toBe(0);
    }, 30_000);
  });

  describe('TTL index', () => {
    it('lets MongoDB delete a dead letter and keep one written without the reset', async () => {
      useWeeklyReset(false);
      const unstamped = await methods.enqueueAgentTriggerDelivery(
        enqueueInput({ availableAt: new Date(Date.now() + 60 * 60_000) }),
      );
      useWeeklyReset(true);
      const expiring = await methods.enqueueAgentTriggerDelivery(enqueueInput());
      const fence = await claimAndBegin(expiring.delivery, 'worker-ttl');
      await methods.deadLetterAgentTriggerDelivery({
        ...fence,
        error: {
          code: 'PERMANENT',
          message: 'synthetic failure',
          certainty: 'definite',
          retryable: false,
          attemptedAt: new Date(),
        },
        settledAt: new Date(),
      });
      await Delivery.updateOne(
        { _id: expiring.delivery.id },
        { $set: { expiredAt: new Date(Date.now() - 1000) } },
      );

      await waitFor(async () => (await stored(expiring.delivery.id)) == null);
      const survivor = await stored(unstamped.delivery.id);
      expect(survivor).not.toBeNull();
      expect(survivor).not.toHaveProperty('expiredAt');
    }, 30_000);

    it('is built beside the upstream expiresAt index and declared once', async () => {
      const indexes = await Delivery.listIndexes();
      expect(indexes).toContainEqual(
        expect.objectContaining({ key: { expiredAt: 1 }, expireAfterSeconds: 0 }),
      );
      expect(indexes).toContainEqual(
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      );

      createAgentTriggerDeliveryModel(mongoose);
      applyWeeklyRetention(triggerDeliverySchema);
      const declared = triggerDeliverySchema.indexes().filter(([fields]) => 'expiredAt' in fields);
      expect(declared).toEqual([
        [{ expiredAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
      ]);
    });
  });

  describe('without RETENTION_WEEKLY_RESET', () => {
    beforeEach(() => useWeeklyReset(false));

    it('writes no expiry', async () => {
      const { delivery } = await methods.enqueueAgentTriggerDelivery(enqueueInput());
      expect(await stored(delivery.id)).not.toHaveProperty('expiredAt');
    });
  });
});
