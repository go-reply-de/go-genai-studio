const { sweepIndex, getMeiliRetentionSweepInterval } = require('./meiliRetentionSweep');

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  runAsSystem: (fn) => fn(),
  buildRetentionVisibilityFilter: () => ({ retention: 'filter' }),
}));

/** Fake Meili index over an ordered id list, mirroring offset/limit paging and queued deletes. */
function createFakeIndex(ids) {
  const docs = [...ids];
  const deleted = [];
  return {
    docs,
    deleted,
    getDocuments: jest.fn(async ({ limit, offset }) => ({
      results: docs.slice(offset, offset + limit).map((id) => ({ messageId: id })),
      total: docs.length,
    })),
    deleteDocuments: jest.fn(async (toDelete) => {
      deleted.push(...toDelete);
      return { taskUid: deleted.length };
    }),
    waitForTask: jest.fn(async () => {
      // Deletions only take effect once the task lands, which is what the sweep awaits.
      for (const id of deleted) {
        const idx = docs.indexOf(id);
        if (idx !== -1) {
          docs.splice(idx, 1);
        }
      }
      return { status: 'succeeded' };
    }),
  };
}

function createFakeModel(liveIds) {
  return {
    find: jest.fn(({ messageId }) => ({
      select: () => ({
        lean: async () =>
          messageId.$in.filter((id) => liveIds.has(id)).map((id) => ({ messageId: id })),
      }),
    })),
  };
}

describe('sweepIndex', () => {
  it('deletes documents Mongo retention no longer keeps', async () => {
    const index = createFakeIndex(['a', 'b', 'c', 'd']);
    const model = createFakeModel(new Set(['a', 'c']));

    const result = await sweepIndex({ index, model, primaryKey: 'messageId', batchSize: 10 });

    expect(index.deleteDocuments).toHaveBeenCalledWith(['b', 'd']);
    expect(result).toEqual({ scanned: 4, deleted: 2 });
    expect(index.docs).toEqual(['a', 'c']);
  });

  it('leaves a fully live index untouched', async () => {
    const index = createFakeIndex(['a', 'b']);
    const model = createFakeModel(new Set(['a', 'b']));

    const result = await sweepIndex({ index, model, primaryKey: 'messageId', batchSize: 10 });

    expect(index.deleteDocuments).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 2, deleted: 0 });
  });

  it('visits every document across pages while deleting, without skipping', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
    // Every third document is expired, so each page shifts the offset window.
    const liveIds = new Set(ids.filter((_, i) => i % 3 !== 0));
    const index = createFakeIndex(ids);
    const model = createFakeModel(liveIds);

    const result = await sweepIndex({ index, model, primaryKey: 'messageId', batchSize: 5 });

    expect(result.deleted).toBe(9);
    expect(index.docs).toEqual(ids.filter((id) => liveIds.has(id)));
  });

  it('awaits each deletion task before advancing the offset', async () => {
    const index = createFakeIndex(['a', 'b', 'c']);
    const model = createFakeModel(new Set(['c']));
    const order = [];
    const originalDelete = index.deleteDocuments;
    const originalWait = index.waitForTask;
    index.deleteDocuments = jest.fn(async (ids) => {
      order.push('delete');
      return originalDelete(ids);
    });
    index.waitForTask = jest.fn(async (uid) => {
      order.push('wait');
      return originalWait(uid);
    });

    await sweepIndex({ index, model, primaryKey: 'messageId', batchSize: 2 });

    expect(order).toEqual(['delete', 'wait']);
  });

  it('stops on an empty index', async () => {
    const index = createFakeIndex([]);
    const model = createFakeModel(new Set());

    const result = await sweepIndex({ index, model, primaryKey: 'messageId', batchSize: 10 });

    expect(result).toEqual({ scanned: 0, deleted: 0 });
    expect(model.find).not.toHaveBeenCalled();
  });
});

describe('getMeiliRetentionSweepInterval', () => {
  it('defaults to hourly', () => {
    expect(getMeiliRetentionSweepInterval(undefined)).toBe(3600000);
    expect(getMeiliRetentionSweepInterval('  ')).toBe(3600000);
  });

  it('honours an explicit interval and 0 to disable', () => {
    expect(getMeiliRetentionSweepInterval('900000')).toBe(900000);
    expect(getMeiliRetentionSweepInterval('0')).toBe(0);
  });

  it('falls back to the default on invalid input', () => {
    expect(getMeiliRetentionSweepInterval('abc')).toBe(3600000);
    expect(getMeiliRetentionSweepInterval('-1')).toBe(3600000);
  });
});
