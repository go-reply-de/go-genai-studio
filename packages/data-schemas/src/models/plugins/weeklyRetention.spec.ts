import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { resetWeeklyRetentionCache } from '~/utils/weeklyRetention';
import { createTransactionModel } from '~/models/transaction';
import { createMessageModel } from '~/models/message';
import transactionSchema from '~/schema/transaction';
import messageSchema from '~/schema/message';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const originalEnv = { ...process.env };
delete process.env.RETENTION_WEEKLY_RESET;
delete process.env.RETENTION_WEEKLY_RESET_TZ;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  process.env = originalEnv;
  resetWeeklyRetentionCache();
  await mongoose.disconnect();
  await mongoServer.stop();
}, DB_SETUP_TIMEOUT_MS);

describe('applyWeeklyRetention without RETENTION_WEEKLY_RESET', () => {
  it('leaves the schemas exactly as defined: no field, no index, no hooks', async () => {
    const transactionIndexes = JSON.stringify(transactionSchema.indexes());
    const messageIndexes = JSON.stringify(messageSchema.indexes());
    const Transaction = createTransactionModel(mongoose);
    const Message = createMessageModel(mongoose);
    await Promise.all([Transaction.init(), Message.init()]);

    expect(transactionSchema.path('expiredAt')).toBeUndefined();
    expect(JSON.stringify(transactionSchema.indexes())).toBe(transactionIndexes);
    expect(JSON.stringify(messageSchema.indexes())).toBe(messageIndexes);
    expect(await Transaction.listIndexes()).not.toContainEqual(
      expect.objectContaining({ key: { expiredAt: 1 } }),
    );

    /* Configured after the models were built, the reset has no hook to act through. */
    process.env.RETENTION_WEEKLY_RESET = 'SUN 23:00';
    process.env.RETENTION_WEEKLY_RESET_TZ = 'Europe/Berlin';
    resetWeeklyRetentionCache();
    const messageId = uuidv4();
    await Message.create({
      messageId,
      conversationId: uuidv4(),
      user: new mongoose.Types.ObjectId().toString(),
      sender: 'AI',
      text: 'synthetic answer',
      isCreatedByUser: false,
    });
    const stored = await Message.findOne({ messageId }).lean();
    expect(stored).not.toBeNull();
    expect(stored?.expiredAt).toBeUndefined();
  });
});
