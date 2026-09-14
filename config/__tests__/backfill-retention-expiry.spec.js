jest.mock('../connect', () => jest.fn().mockResolvedValue(true));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { collectAgentFileIds, buildTargets } = require('../backfill-retention-expiry');

describe('backfill-retention-expiry', () => {
  let mongoServer;
  let db;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    db = mongoose.connection.db;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await db.collection('agents').deleteMany({});
    await db.collection('files').deleteMany({});
  });

  describe('collectAgentFileIds', () => {
    it('collects ids from every tool resource type', async () => {
      await db.collection('agents').insertOne({
        id: 'agent_a',
        tool_resources: {
          file_search: { file_ids: ['regelwerk-1', 'regelwerk-2'] },
          context: { file_ids: ['context-1'] },
        },
      });

      expect([...(await collectAgentFileIds(db))].sort()).toEqual([
        'context-1',
        'regelwerk-1',
        'regelwerk-2',
      ]);
    });

    it('includes files referenced only by a superseded agent version', async () => {
      await db.collection('agents').insertOne({
        id: 'agent_a',
        tool_resources: { file_search: { file_ids: ['current'] } },
        versions: [{ tool_resources: { file_search: { file_ids: ['from-an-old-version'] } } }],
      });

      const ids = await collectAgentFileIds(db);
      expect(ids.has('from-an-old-version')).toBe(true);
      expect(ids.has('current')).toBe(true);
    });

    it('survives agents with missing or malformed tool_resources', async () => {
      await db.collection('agents').insertMany([
        { id: 'no-resources' },
        { id: 'null-resources', tool_resources: null },
        { id: 'string-resources', tool_resources: 'nonsense' },
        { id: 'empty', tool_resources: {} },
        { id: 'no-file-ids', tool_resources: { file_search: {} } },
        { id: 'bad-versions', tool_resources: {}, versions: 'not-an-array' },
        { id: 'null-version', tool_resources: {}, versions: [null] },
        { id: 'good', tool_resources: { file_search: { file_ids: ['keep-me'] } } },
      ]);

      expect([...(await collectAgentFileIds(db))]).toEqual(['keep-me']);
    });

    it('returns an empty set when there are no agents', async () => {
      expect((await collectAgentFileIds(db)).size).toBe(0);
    });
  });

  describe('file selection', () => {
    const fileFilter = (agentFileIds) =>
      buildTargets(agentFileIds).find((t) => t.name === 'files').filter;

    const selectFiles = async (agentFileIds) => {
      const found = await db.collection('files').find(fileFilter(agentFileIds)).toArray();
      return found.map((f) => f.file_id).sort();
    };

    it('selects patient uploads and spares everything that is not patient data', async () => {
      await db.collection('agents').insertOne({
        id: 'agent_a',
        tool_resources: { file_search: { file_ids: ['regelwerk'] } },
      });
      await db.collection('files').insertMany([
        { file_id: 'patient-upload', context: 'message_attachment', expiredAt: null },
        { file_id: 'generated-image', context: 'image_generation', expiredAt: null },
        { file_id: 'regelwerk', context: 'agents', expiredAt: null },
        { file_id: 'user-avatar', context: 'avatar', expiredAt: null },
        { file_id: 'a-skill-file', context: 'skill_file', expiredAt: null },
        { file_id: 'already-stamped', context: 'message_attachment', expiredAt: new Date() },
      ]);

      expect(await selectFiles(await collectAgentFileIds(db))).toEqual([
        'generated-image',
        'patient-upload',
      ]);
    });

    it('spares an agent file whose context does not say it is one', async () => {
      // The dangerous case: a knowledge-base document attached before
      // `retainAgentFiles` existed carries a null expiry and an innocuous
      // context, so only the agent reference identifies it.
      await db.collection('agents').insertOne({
        id: 'agent_a',
        tool_resources: { file_search: { file_ids: ['mislabelled-regelwerk'] } },
      });
      await db.collection('files').insertMany([
        { file_id: 'mislabelled-regelwerk', context: 'message_attachment', expiredAt: null },
        { file_id: 'patient-upload', context: 'message_attachment', expiredAt: null },
      ]);

      expect(await selectFiles(await collectAgentFileIds(db))).toEqual(['patient-upload']);
    });

    it('would have deleted that file without the agent-reference guard', async () => {
      // Proves the guard earns its place rather than duplicating the context check.
      await db.collection('files').insertOne({
        file_id: 'mislabelled-regelwerk',
        context: 'message_attachment',
        expiredAt: null,
      });

      expect(await selectFiles(new Set())).toEqual(['mislabelled-regelwerk']);
    });

    it('treats a missing expiredAt field the same as null', async () => {
      // Rows saved before the field existed have no key at all, and a TTL index
      // ignores both — so the backfill has to catch both.
      await db.collection('files').insertOne({ file_id: 'legacy', context: 'message_attachment' });

      expect(await selectFiles(new Set())).toEqual(['legacy']);
    });
  });

  describe('non-file targets', () => {
    it('selects only rows without an expiry', async () => {
      const targets = buildTargets(new Set());
      for (const name of ['conversations', 'messages', 'sharedlinks']) {
        await db.collection(name).deleteMany({});
        await db
          .collection(name)
          .insertMany([
            { marker: 'null-expiry', expiredAt: null },
            { marker: 'absent-expiry' },
            { marker: 'already-stamped', expiredAt: new Date() },
          ]);

        const filter = targets.find((t) => t.name === name).filter;
        const found = await db.collection(name).find(filter).toArray();
        expect(found.map((d) => d.marker).sort()).toEqual(['absent-expiry', 'null-expiry']);
      }
    });
  });
});
