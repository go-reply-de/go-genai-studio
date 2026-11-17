const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { nextWeeklyReset, parseWeeklyReset } = require('@librechat/data-schemas');
const { parseReset, weekOf, countWeek, writeWeek, runJob } = require('./groups-job');

const SUNDAY_23 = parseReset('SUN 23:00', 'Europe/Berlin');
const at = (iso) => new Date(iso);
const iso = (window) => ({
  week: window.week,
  start: window.start.toISOString(),
  end: window.end.toISOString(),
});

describe('weekOf', () => {
  it('runs from the reset before to the reset after, named by its Monday', () => {
    expect(iso(weekOf(at('2026-11-18T10:00:00Z'), SUNDAY_23))).toEqual({
      week: '2026-11-16',
      start: '2026-11-15T22:00:00.000Z',
      end: '2026-11-22T22:00:00.000Z',
    });
  });

  it('keeps Sunday before 23:00 in the ending week', () => {
    expect(weekOf(at('2026-11-22T21:50:00Z'), SUNDAY_23).week).toBe('2026-11-16');
  });

  it('starts the next week with the reset at 23:00 Berlin time', () => {
    expect(weekOf(at('2026-11-22T22:00:00Z'), SUNDAY_23).week).toBe('2026-11-23');
  });

  it('gives the week of the October clock change its extra hour', () => {
    expect(iso(weekOf(at('2026-10-25T21:30:00Z'), SUNDAY_23))).toEqual({
      week: '2026-10-19',
      start: '2026-10-18T21:00:00.000Z',
      end: '2026-10-25T22:00:00.000Z',
    });
    expect(weekOf(at('2026-10-25T22:10:00Z'), SUNDAY_23).week).toBe('2026-10-26');
  });

  it('follows the reset in the week of the March clock change', () => {
    expect(iso(weekOf(at('2026-03-29T20:30:00Z'), SUNDAY_23))).toEqual({
      week: '2026-03-23',
      start: '2026-03-22T22:00:00.000Z',
      end: '2026-03-29T21:00:00.000Z',
    });
  });

  it("ends each week exactly when LibreChat's weekly reset deletes the chats", () => {
    const reset = parseWeeklyReset('SUN 23:00', 'Europe/Berlin');
    for (
      let t = Date.parse('2026-01-01T00:00:00Z');
      t < Date.parse('2027-01-01Z');
      t += 3.7e6 * 7
    ) {
      expect(weekOf(new Date(t), SUNDAY_23).end).toEqual(nextWeeklyReset(reset, new Date(t)));
    }
  });

  it('reads the reset like LibreChat does, in UTC when no zone is set', () => {
    expect(parseReset('sun 23:00', '')).toEqual({ day: 0, hour: 23, minute: 0, timeZone: 'UTC' });
    expect(parseReset('', 'Europe/Berlin')).toBeNull();
    expect(parseReset('Sunday', 'Europe/Berlin')).toBeNull();
  });

  it('runs Monday to Monday in Berlin when no weekly reset is set', () => {
    expect(iso(weekOf(at('2026-11-22T22:30:00Z'), null))).toEqual({
      week: '2026-11-16',
      start: '2026-11-15T23:00:00.000Z',
      end: '2026-11-22T23:00:00.000Z',
    });
  });
});

describe('with MongoDB', () => {
  let server;
  let client;
  let db;
  const START = at('2026-11-15T22:00:00Z');
  const END = at('2026-11-22T22:00:00Z');
  const IN = at('2026-11-18T09:00:00Z');
  const BEFORE = at('2026-11-15T21:59:00Z');
  const alice = new ObjectId();
  const bob = new ObjectId();
  const carol = new ObjectId();
  const dave = new ObjectId();

  /** A token record as LibreChat writes one per model call; deleting the chat keeps it. */
  const transaction = (user, conversationId, tokenType, rawAmount, createdAt = IN) => ({
    user,
    ...(conversationId && { conversationId }),
    tokenType,
    rawAmount,
    createdAt,
  });

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    db = client.db('LibreChat');
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  beforeEach(async () => {
    await db.collection('conversations').deleteMany({});
    await db.collection('transactions').deleteMany({});
    // Only one of alice's two chats is still stored; she deleted the other.
    await db.collection('conversations').insertOne({ user: String(alice), conversationId: 'a1' });
    await db
      .collection('transactions')
      .insertMany([
        transaction(alice, 'a1', 'prompt', -1200),
        transaction(alice, 'a1', 'completion', -300),
        transaction(alice, 'a2', 'prompt', -100),
        transaction(alice, 'a1', 'credits', -50),
        transaction(alice, 'a0', 'prompt', -999, BEFORE),
        transaction(bob, 'b1', 'prompt', -400),
        transaction(carol, null, 'prompt', -700),
        transaction(dave, 'd1', 'prompt', -800, BEFORE),
      ]);
  });

  describe('countWeek', () => {
    it("counts each user's conversations with a model call in the week and their tokens", async () => {
      const counts = await countWeek(db, START, END);
      expect(counts.sort((a, b) => b.conversations - a.conversations)).toEqual([
        { conversations: 2, tokens: 1600 },
        { conversations: 1, tokens: 400 },
      ]);
    });

    it('still counts a conversation the user has deleted, like its tokens', async () => {
      const counts = await countWeek(db, START, END);
      expect(counts.find((c) => c.tokens === 1600).conversations).toBe(2);
    });

    it('leaves out users without a conversation in the week', async () => {
      const counts = await countWeek(db, START, END);
      expect(counts).toHaveLength(2);
    });
  });

  describe('runJob', () => {
    it("writes the running week's rows and logs no user", async () => {
      const writes = [];
      const lines = [];
      await runJob({
        db,
        now: () => IN,
        reset: SUNDAY_23,
        google: {
          table: async (name) => `\`synthetic-project.feedback.${name}\``,
          query: async (sql, params) => {
            writes.push({ sql, params });
            return { rows: [], changed: 1 };
          },
        },
        log: (severity, message, fields) => lines.push({ severity, message, ...fields }),
      });
      expect(writes).toHaveLength(1);
      expect(writes[0].params.week).toEqual({ type: 'DATE', value: '2026-11-16' });
      expect(writes[0].params.users0).toEqual({ type: 'INT64', value: '2' });
      expect(lines).toEqual([
        { severity: 'INFO', message: 'usage groups written', week: '2026-11-16', rows: 1 },
      ]);
      const logged = JSON.stringify(lines);
      for (const id of [alice, bob, carol]) {
        expect(logged).not.toContain(String(id));
      }
    });
  });
});

describe('writeWeek', () => {
  const run = async (rows) => {
    const calls = [];
    const google = {
      table: async (name) => `\`synthetic-project.feedback.${name}\``,
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [], changed: rows.length };
      },
    };
    await writeWeek(google, '2026-11-16', rows);
    return calls;
  };

  it("replaces the week's rows in one statement", async () => {
    const calls = await run([
      { min: 10, max: null, users: 6, conversationsShare: 52, tokensShare: 65 },
      { min: 1, max: 9, users: 28, conversationsShare: 48, tokensShare: 35 },
    ]);
    expect(calls).toHaveLength(1);
    const [{ sql, params }] = calls;
    expect(sql).toMatch(/^MERGE `synthetic-project\.feedback\.usage_groups`/);
    expect(sql).toContain('WHEN NOT MATCHED BY SOURCE AND T.week = @week THEN DELETE');
    expect(params).toEqual({
      week: { type: 'DATE', value: '2026-11-16' },
      min0: { type: 'INT64', value: '10' },
      users0: { type: 'INT64', value: '6' },
      conversations0: { type: 'INT64', value: '52' },
      tokens0: { type: 'INT64', value: '65' },
      min1: { type: 'INT64', value: '1' },
      max1: { type: 'INT64', value: '9' },
      users1: { type: 'INT64', value: '28' },
      conversations1: { type: 'INT64', value: '48' },
      tokens1: { type: 'INT64', value: '35' },
    });
  });

  it('writes an open-ended group without an upper bound', async () => {
    const [{ sql }] = await run([
      { min: 1, max: null, users: 4, conversationsShare: 100, tokensShare: 100 },
    ]);
    expect(sql).toContain('CAST(NULL AS INT64) AS max_conversations');
  });
});
