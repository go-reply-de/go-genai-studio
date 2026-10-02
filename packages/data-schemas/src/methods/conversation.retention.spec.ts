import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { RetentionMode } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Schema } from 'mongoose';
import type { AppConfig } from '~/types';
import { getWeeklyReset, nextWeeklyReset } from '~/utils/weeklyRetention';
import { applyWeeklyRetention } from '~/models/plugins/weeklyRetention';
import messageSchema from '~/schema/message';
import convoSchema from '~/schema/convo';
import { createModels } from '~/models';
import { createMethods } from './index';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const BERLIN = 'Europe/Berlin';
const originalEnv = { ...process.env };
/* The plugin only shapes schemas built while the reset is configured. */
process.env.RETENTION_WEEKLY_RESET = 'SUN 23:00';
process.env.RETENTION_WEEKLY_RESET_TZ = BERLIN;
const retainAll: AppConfig['interfaceConfig'] = { retentionMode: RetentionMode.ALL };

let mongoServer: MongoMemoryServer;
let models: ReturnType<typeof createModels>;
let methods: ReturnType<typeof createMethods>;
let user: string;

/** Any persisted row, including the field the retention plugin owns. */
interface StoredRow {
  expiredAt?: Date | null;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  models = createModels(mongoose);
  methods = createMethods(mongoose);
  await Promise.all([
    models.Message.init(),
    models.Conversation.init(),
    models.SharedLink.init(),
    models.ToolCall.init(),
    models.Transaction.init(),
  ]);
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  process.env = originalEnv;
  await mongoose.disconnect();
  await mongoServer.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all([
    models.Message.deleteMany({}),
    models.Conversation.deleteMany({}),
    models.SharedLink.deleteMany({}),
    models.ToolCall.deleteMany({}),
    models.Transaction.deleteMany({}),
  ]);
  user = new mongoose.Types.ObjectId().toString();
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
function expectWeeklyBoundary(expiredAt: Date | null | undefined, writtenFrom: Date): void {
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

const messageExpiry = async (messageId: string) =>
  (await models.Message.findOne({ messageId }).lean<StoredRow>())?.expiredAt;
const conversationExpiry = async (conversationId: string) =>
  (await models.Conversation.findOne({ conversationId }).lean<StoredRow>())?.expiredAt;
const sharedLinkExpiry = async (conversationId: string) =>
  (await models.SharedLink.findOne({ conversationId }).lean<StoredRow>())?.expiredAt;

/** A stopped or disconnected response, as the abort and disconnect paths persist it. */
function unfinishedResponse(conversationId: string) {
  return {
    messageId: uuidv4(),
    conversationId,
    parentMessageId: uuidv4(),
    sender: 'AI',
    text: 'synthetic partial answer',
    endpoint: 'google',
    model: 'synthetic-model',
    unfinished: true,
    error: false,
    isCreatedByUser: false,
  };
}

function expiryIndexes(schema: Schema): unknown[] {
  return schema
    .indexes()
    .filter(([fields]) => Object.keys(fields).length === 1 && 'expiredAt' in fields);
}

describe('weekly retention on conversation content', () => {
  describe('messages', () => {
    it('stamps an unfinished response saved without the interface config', async () => {
      const writtenFrom = new Date();
      const response = unfinishedResponse(uuidv4());

      await methods.saveMessage({ userId: user, isTemporary: false }, response);

      expect(await models.Message.countDocuments({ messageId: response.messageId })).toBe(1);
      expectWeeklyBoundary(await messageExpiry(response.messageId), writtenFrom);
    });

    it('keeps the expiry when a later write without that context rewrites the row', async () => {
      const response = unfinishedResponse(uuidv4());
      await methods.saveMessage({ userId: user, interfaceConfig: retainAll }, response);
      const stamped = await messageExpiry(response.messageId);
      expectWeeklyBoundary(stamped, new Date());

      await methods.saveMessage({ userId: user, isTemporary: false }, response);
      await methods.updateMessage(user, { messageId: response.messageId, expiredAt: null });

      expect(await messageExpiry(response.messageId)).toEqual(stamped);
    });

    it('stamps imports, recorded messages and direct creates', async () => {
      const writtenFrom = new Date();
      const conversationId = uuidv4();
      const imported = unfinishedResponse(conversationId);
      const recorded = unfinishedResponse(conversationId);
      const created = unfinishedResponse(conversationId);

      await methods.bulkSaveMessages([{ ...imported, user }], true);
      await methods.recordMessage({ ...recorded, user });
      await models.Message.create({ ...created, user });

      expect(await models.Message.countDocuments({ conversationId })).toBe(3);
      for (const { messageId } of [imported, recorded, created]) {
        expectWeeklyBoundary(await messageExpiry(messageId), writtenFrom);
      }
    });

    it('reuses the schema expiry field and declares its TTL index once', async () => {
      applyWeeklyRetention(messageSchema);
      expect(expiryIndexes(messageSchema)).toEqual([
        [{ expiredAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
      ]);
      expect(await models.Message.listIndexes()).toContainEqual(
        expect.objectContaining({ key: { expiredAt: 1 }, expireAfterSeconds: 0 }),
      );
    });
  });

  describe('conversations', () => {
    it('stamps a conversation saved without the interface config and keeps it on resave', async () => {
      const writtenFrom = new Date();
      const conversationId = uuidv4();

      await methods.saveConvo(
        { userId: user, isTemporary: false },
        { conversationId, title: 'synthetic title', endpoint: 'google' },
      );
      const stamped = await conversationExpiry(conversationId);
      expectWeeklyBoundary(stamped, writtenFrom);

      await methods.saveConvo(
        { userId: user, isTemporary: false },
        { conversationId, title: 'synthetic rename', endpoint: 'google' },
      );
      expect(await conversationExpiry(conversationId)).toEqual(stamped);
    });

    it('reuses the schema expiry field and declares its TTL index once', () => {
      applyWeeklyRetention(convoSchema);
      expect(expiryIndexes(convoSchema)).toEqual([
        [{ expiredAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
      ]);
    });
  });

  describe('shared links', () => {
    it('stamps a link created without an expiry and keeps one when an update unsets it', async () => {
      const writtenFrom = new Date();
      const conversationId = uuidv4();
      await methods.saveConvo(
        { userId: user, interfaceConfig: retainAll },
        { conversationId, title: 'synthetic title', endpoint: 'google' },
      );
      await methods.saveMessage(
        { userId: user, interfaceConfig: retainAll },
        { ...unfinishedResponse(conversationId), unfinished: false },
      );

      const created = await methods.createSharedLink(user, conversationId);
      expect(created.conversationId).toBe(conversationId);
      expectWeeklyBoundary(await sharedLinkExpiry(conversationId), writtenFrom);

      await methods.updateSharedLink(user, created.shareId, undefined, null);
      expectWeeklyBoundary(await sharedLinkExpiry(conversationId), writtenFrom);
    });
  });

  describe('tool calls', () => {
    it('stamps a tool call created without an expiry', async () => {
      const writtenFrom = new Date();
      const messageId = uuidv4();
      await models.ToolCall.create({
        conversationId: uuidv4(),
        messageId,
        toolId: 'synthetic_tool',
        user: new mongoose.Types.ObjectId(user),
        result: 'synthetic tool output',
      });

      const stored = await models.ToolCall.findOne({ messageId }).lean<StoredRow>();
      expect(stored).not.toBeNull();
      expectWeeklyBoundary(stored?.expiredAt, writtenFrom);
    });
  });

  describe('usage transactions', () => {
    const usage = {
      conversationId: 'synthetic-conversation',
      model: 'synthetic-model',
      context: 'message',
    };

    it('stamps single and bulk writes', async () => {
      const writtenFrom = new Date();
      await methods.createTransaction({
        ...usage,
        user,
        endpointTokenConfig: null,
        rawAmount: -100,
        tokenType: 'prompt',
      });
      await methods.bulkInsertTransactions([
        { ...usage, user, rawAmount: -50, tokenType: 'completion', tokenValue: -50, rate: 1 },
      ]);

      const rows = await models.Transaction.find({ user }).lean<StoredRow[]>();
      expect(rows).toHaveLength(2);
      rows.forEach((row) => expectWeeklyBoundary(row.expiredAt, writtenFrom));
      expect(await models.Transaction.listIndexes()).toContainEqual(
        expect.objectContaining({ key: { expiredAt: 1 }, expireAfterSeconds: 0 }),
      );
    });

    it('writes nothing when transactions are disabled', async () => {
      await methods.createTransaction({
        ...usage,
        user,
        endpointTokenConfig: null,
        rawAmount: -100,
        tokenType: 'prompt',
        transactions: { enabled: false },
      });

      expect(await models.Transaction.countDocuments({ user })).toBe(0);
    });
  });

  describe('writes that name an expiry', () => {
    it('keep an earlier one and pull a later one in to the boundary', async () => {
      const boundary = currentBoundary();
      const earlier = new Date(boundary.getTime() - 1);
      const later = new Date(boundary.getTime() + WEEK_MS);
      const conversationId = uuidv4();
      const kept = unfinishedResponse(conversationId);
      const clamped = unfinishedResponse(conversationId);

      await methods.saveMessage({ userId: user, expiredAt: earlier }, kept);
      await methods.saveMessage({ userId: user, expiredAt: later }, clamped);

      expect(await messageExpiry(kept.messageId)).toEqual(earlier);
      expect(await messageExpiry(clamped.messageId)).toEqual(boundary);
    });
  });

  describe('without RETENTION_WEEKLY_RESET', () => {
    beforeEach(() => useWeeklyReset(false));

    it('leaves the upstream result of an unfinished save untouched', async () => {
      const response = unfinishedResponse(uuidv4());
      await methods.saveMessage({ userId: user, isTemporary: false }, response);

      expect(await messageExpiry(response.messageId)).toBeNull();
    });
  });
});
