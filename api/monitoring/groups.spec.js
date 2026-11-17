const { groupWeek, percents } = require('./groups');

/** `n` users with the same conversations and tokens each. */
const users = (n, conversations, tokens = conversations * 1000) =>
  Array.from({ length: n }, () => ({ conversations, tokens }));

const ranges = (rows) => rows.map((row) => [row.min, row.max, row.users]);

describe('percents', () => {
  it('rounds to whole percentages that add up to 100', () => {
    expect(percents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percents([52, 37, 11])).toEqual([52, 37, 11]);
  });

  it('gives the largest remainders the missing points', () => {
    expect(percents([2, 3, 5, 7])).toEqual([12, 18, 29, 41]);
  });

  it('is all zero when there is nothing to share', () => {
    expect(percents([0, 0])).toEqual([0, 0]);
  });
});

describe('groupWeek', () => {
  it('groups users by conversations: 10 or more, 3 to 9, 1 or 2', () => {
    const rows = groupWeek([...users(6, 12), ...users(12, 4), ...users(16, 1)]);
    expect(ranges(rows)).toEqual([
      [10, null, 6],
      [3, 9, 12],
      [1, 2, 16],
    ]);
  });

  it("gives each group its share of the week's conversations and tokens", () => {
    const rows = groupWeek([...users(5, 10, 6000), ...users(5, 5, 3000), ...users(5, 2, 1000)]);
    expect(rows.map((row) => row.conversationsShare)).toEqual([59, 29, 12]);
    expect(rows.map((row) => row.tokensShare)).toEqual([60, 30, 10]);
  });

  it('merges a group of fewer than 5 users into the group below it', () => {
    const rows = groupWeek([...users(2, 15), ...users(6, 4), ...users(7, 1)]);
    expect(ranges(rows)).toEqual([
      [3, null, 8],
      [1, 2, 7],
    ]);
  });

  it('merges an empty group as well, so none and a few look the same', () => {
    const rows = groupWeek([...users(6, 4), ...users(7, 1)]);
    expect(ranges(rows)).toEqual([
      [3, null, 6],
      [1, 2, 7],
    ]);
  });

  it('merges a small last group into the group above it', () => {
    const rows = groupWeek([...users(6, 12), ...users(6, 4), ...users(3, 1)]);
    expect(ranges(rows)).toEqual([
      [10, null, 6],
      [1, 9, 9],
    ]);
  });

  it('keeps one row for everyone when no split leaves 5 users in each group', () => {
    const rows = groupWeek([...users(1, 12), ...users(2, 4), ...users(9, 1)]);
    expect(rows).toEqual([
      { min: 1, max: null, users: 12, conversationsShare: 100, tokensShare: 100 },
    ]);
  });

  it('does not split a week with fewer than 10 active users', () => {
    const rows = groupWeek([...users(5, 12), ...users(4, 1)]);
    expect(ranges(rows)).toEqual([[1, null, 9]]);
  });

  it('stores a week without active users as one empty row', () => {
    expect(groupWeek([])).toEqual([
      { min: 1, max: null, users: 0, conversationsShare: 0, tokensShare: 0 },
    ]);
  });

  it('adds every share up to 100', () => {
    const rows = groupWeek([...users(7, 11, 997), ...users(11, 3, 991), ...users(13, 2, 13)]);
    const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
    expect(total('conversationsShare')).toBe(100);
    expect(total('tokensShare')).toBe(100);
  });
});
