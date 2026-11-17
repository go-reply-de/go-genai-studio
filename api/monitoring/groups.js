/**
 * Usage groups: a week's active users grouped by how many conversations each had. Only these
 * rows are kept; the per-user counts they come from never leave the job's memory.
 */

/** From most to least use. `max: null` has no upper bound. */
const GROUPS = [
  { key: 'power', min: 10, max: null },
  { key: 'regular', min: 3, max: 9 },
  { key: 'occasional', min: 1, max: 2 },
];
/** No row may describe fewer people than this. */
const MIN_USERS = 5;
/** Below this a week is not split at all. */
const MIN_ACTIVE = 10;

const sum = (values) => values.reduce((a, b) => a + b, 0);

/** Whole percentages that add up to 100: the largest remainders get the missing points. */
function percents(parts) {
  const total = sum(parts);
  if (!total) {
    return parts.map(() => 0);
  }
  const raw = parts.map((part) => (100 * part) / total);
  const out = raw.map(Math.floor);
  const order = raw
    .map((r, i) => [r - Math.floor(r), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const missing = 100 - sum(out);
  for (let k = 0; k < missing; k++) {
    out[order[k][1]]++;
  }
  return out;
}

const inGroup = (group, conversations) =>
  conversations >= group.min && (group.max === null || conversations <= group.max);

/**
 * A group with fewer than MIN_USERS users, an empty one too, joins its neighbour below (the last
 * one joins the one above), until every group is large enough or only one is left.
 */
function mergeSmall(groups) {
  let merged = groups;
  let small = merged.findIndex((g) => g.members.length < MIN_USERS);
  while (small >= 0 && merged.length > 1) {
    const upper = small === merged.length - 1 ? small - 1 : small;
    const [a, b] = [merged[upper], merged[upper + 1]];
    const joined = { min: b.min, max: a.max, members: [...a.members, ...b.members] };
    merged = [...merged.slice(0, upper), joined, ...merged.slice(upper + 2)];
    small = merged.findIndex((g) => g.members.length < MIN_USERS);
  }
  return merged;
}

/**
 * The rows to store for a week, from each active user's `{ conversations, tokens }`. A week with
 * fewer than MIN_ACTIVE users stays one row for everyone.
 */
function groupWeek(users) {
  const groups =
    users.length < MIN_ACTIVE
      ? [{ min: 1, max: null, members: users }]
      : mergeSmall(
          GROUPS.map((g) => ({
            min: g.min,
            max: g.max,
            members: users.filter((u) => inGroup(g, u.conversations)),
          })),
        );
  const conversations = percents(groups.map((g) => sum(g.members.map((u) => u.conversations))));
  const tokens = percents(groups.map((g) => sum(g.members.map((u) => u.tokens))));
  return groups.map((g, i) => ({
    min: g.min,
    max: g.max,
    users: g.members.length,
    conversationsShare: conversations[i],
    tokensShare: tokens[i],
  }));
}

module.exports = { GROUPS, MIN_ACTIVE, groupWeek, percents };
