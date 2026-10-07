import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getWeeklyReset, nextWeeklyReset } from '~/utils/weeklyRetention';
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
const originalEnv = { ...process.env };
/* The plugin only shapes schemas built while the reset is configured. */
process.env.RETENTION_WEEKLY_RESET = 'SUN 23:00';
process.env.RETENTION_WEEKLY_RESET_TZ = 'Europe/Berlin';

let mongoServer: MongoMemoryServer;
let models: ReturnType<typeof createModels>;
let methods: ReturnType<typeof createMethods>;
let user: string;

/** The persisted row, including the field the retention plugin owns. */
interface StoredProject {
  expiredAt?: Date;
}

beforeAll(async () => {
  /* A one-second TTL pass lets the spec watch MongoDB delete an expired project. */
  mongoServer = await MongoMemoryServer.create({
    instance: { args: ['--setParameter', 'ttlMonitorSleepSecs=1'] },
  });
  await mongoose.connect(mongoServer.getUri());
  models = createModels(mongoose);
  methods = createMethods(mongoose);
  await Promise.all([models.ChatProject.init(), models.Conversation.init()]);
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  process.env = originalEnv;
  await mongoose.disconnect();
  await mongoServer.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all([models.ChatProject.deleteMany({}), models.Conversation.deleteMany({})]);
  user = new mongoose.Types.ObjectId().toString();
});

function currentBoundary(): Date {
  const reset = getWeeklyReset();
  if (reset == null) {
    throw new Error('The spec expects RETENTION_WEEKLY_RESET to be set');
  }
  return nextWeeklyReset(reset);
}

async function projectExpiry(projectId: string): Promise<Date | undefined> {
  return (await models.ChatProject.findById(projectId).lean<StoredProject>())?.expiredAt;
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

describe('chat project weekly retention', () => {
  it('stamps a new project with the boundary and keeps it through a rename', async () => {
    const project = await methods.createChatProject(user, {
      name: 'Synthetic project',
      description: 'synthetic description',
    });
    const projectId = String(project._id);
    const boundary = currentBoundary();

    expect(await projectExpiry(projectId)).toEqual(boundary);
    await methods.updateChatProject(user, projectId, { name: 'Synthetic rename' });
    expect(await projectExpiry(projectId)).toEqual(boundary);
    expect(boundary.getTime() - Date.now()).toBeLessThanOrEqual(WEEK_MS);
  });

  it('lets a conversation save once its project has expired, without the stale reference', async () => {
    const project = await methods.createChatProject(user, { name: 'Synthetic project' });
    const projectId = String(project._id);
    await models.ChatProject.updateOne(
      { _id: projectId },
      { $set: { expiredAt: new Date(Date.now() - 1000) } },
    );
    await waitFor(async () => (await models.ChatProject.exists({ _id: projectId })) == null);

    const conversationId = uuidv4();
    await methods.saveConvo(
      { userId: user, isTemporary: false },
      { conversationId, title: 'synthetic title', endpoint: 'google', chatProjectId: projectId },
    );

    const stored = await models.Conversation.findOne({ conversationId }).lean();
    expect(stored).not.toBeNull();
    expect(stored?.chatProjectId ?? null).toBeNull();
    expect((await methods.listChatProjects(user)).projects).toHaveLength(0);
  }, 30_000);

  it('builds one TTL index on chatprojects', async () => {
    expect(await models.ChatProject.listIndexes()).toContainEqual(
      expect.objectContaining({ key: { expiredAt: 1 }, expireAfterSeconds: 0 }),
    );
  });
});
