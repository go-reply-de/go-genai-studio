import { randomUUID } from 'crypto';
import { FEEDBACK_RATINGS, FEEDBACK_REASON_KEYS } from 'librechat-data-provider';

/** The feedback box stops at 500 characters; a hand-made request can send more. */
const MAX_TEXT_LENGTH = 500;

/** Best effort against identifiers the disclaimer asks people to leave out. */
const MASKS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g, '[E-Mail]'],
  [/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g, '[Datum]'],
  [/\d{6,}/g, '[Nummer]'],
];

/** Private Google Access in the cluster serves *.googleapis.com, not the regional rep names. */
const BIGQUERY = 'https://bigquery.googleapis.com/bigquery/v2';
const METADATA = 'http://metadata.google.internal/computeMetadata/v1';

export type FeedbackInput = { rating?: unknown; tag?: unknown; text?: unknown } | null;

/**
 * A change to the counts: `ratings` is +1 for a rating given and -1 for the one it replaces or
 * withdraws; `texts` is 1 when a text was saved with it.
 */
export type FeedbackCountRow = {
  date: string;
  rating: string;
  reason: string;
  ratings: -1 | 0 | 1;
  texts: 0 | 1;
};

export type FeedbackTextRow = {
  id: string;
  date: string;
  rating: string;
  reason: string;
  text: string;
};

export type FeedbackRows = { counts: FeedbackCountRow[]; texts: FeedbackTextRow[] };

/** FEEDBACK_DATASET also tells the client to show the feedback dialog's privacy hint. */
export function feedbackDataset(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dataset = env.FEEDBACK_DATASET?.trim();
  return dataset ? dataset : undefined;
}

export function isFeedbackStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return feedbackDataset(env) != null;
}

function known<T extends string>(values: readonly T[], value: unknown): T | 'unknown' {
  return values.includes(value as T) ? (value as T) : 'unknown';
}

function ratingOf(feedback: FeedbackInput | undefined) {
  if (feedback?.rating == null) {
    return undefined;
  }
  return {
    rating: known(FEEDBACK_RATINGS, feedback.rating),
    reason: known(FEEDBACK_REASON_KEYS, feedback.tag),
  };
}

function maskedText(feedback: FeedbackInput | undefined): string | undefined {
  if (typeof feedback?.text !== 'string') {
    return undefined;
  }
  let text = feedback.text.trim().slice(0, MAX_TEXT_LENGTH);
  for (const [pattern, mask] of MASKS) {
    text = text.replace(pattern, mask);
  }
  return text || undefined;
}

/**
 * The rows one feedback update adds: the day, never the time, and no user, chat or message id.
 * Counts move by -1 for the rating replaced or withdrawn and +1 for the new one, so their sums
 * stay right without an id. A new or changed text gets its own row, with a random id that only
 * addresses that row, and is counted once. `previous` is undefined when the stored feedback could
 * not be read; then no rating count moves.
 */
export function feedbackRows(
  previous: FeedbackInput | undefined,
  next: FeedbackInput | undefined,
  now: Date = new Date(),
): FeedbackRows {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(now);
  const before = ratingOf(previous);
  const after = ratingOf(next);
  const changed = before?.rating !== after?.rating || before?.reason !== after?.reason;
  const moves = changed && previous !== undefined;

  const text = maskedText(next);
  const texts: FeedbackTextRow[] =
    after && text && (changed || text !== maskedText(previous))
      ? [{ id: randomUUID(), date, ...after, text }]
      : [];

  const counts: FeedbackCountRow[] = [];
  if (moves && before) {
    counts.push({ date, ...before, ratings: -1, texts: 0 });
  }
  if (after && (moves || texts.length > 0)) {
    counts.push({ date, ...after, ratings: moves ? 1 : 0, texts: texts.length > 0 ? 1 : 0 });
  }
  return { counts, texts };
}

/**
 * The stored feedback before an update, read only while the store is on: null when there was
 * none, undefined when the lookup failed.
 */
export async function feedbackBefore(
  load: () => Promise<{ feedback?: FeedbackInput } | null | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeedbackInput | undefined> {
  if (!isFeedbackStoreEnabled(env)) {
    return undefined;
  }
  try {
    return (await load())?.feedback ?? null;
  } catch {
    return undefined;
  }
}

/** Not the app logger: it adds the request's user id, which must not sit next to a feedback. */
function logFailure(where: string, reason: string): void {
  const message = `[feedback] Not saved to BigQuery ${where}: ${reason}`;
  process.stderr.write(`${JSON.stringify({ severity: 'ERROR', message })}\n`);
}

function describe(error: unknown): string {
  const cause = (error as Error & { cause?: { code?: string } })?.cause?.code;
  return `${(error as Error)?.message}${cause ? ` (${cause})` : ''}`;
}

async function metadata(path: string, fetchFn: typeof fetch): Promise<Response> {
  return fetchFn(`${METADATA}/${path}`, { headers: { 'Metadata-Flavor': 'Google' } });
}

async function insertAll(
  fetchFn: typeof fetch,
  url: string,
  token: string,
  where: string,
  rows: Array<{ insertId: string; json: object }>,
): Promise<void> {
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    const body = res.ok ? await res.json() : undefined;
    if (!res.ok || body?.insertErrors?.length) {
      logFailure(where, res.ok ? 'row rejected' : `HTTP ${res.status}`);
    }
  } catch (error) {
    logFailure(where, describe(error));
  }
}

/**
 * Adds a feedback update's rows to the tables `counts` and `texts` of the BigQuery dataset in
 * FEEDBACK_DATASET, as the pod's Workload Identity service account. Reviewers delete or clean
 * texts without touching a count. Streaming inserts leave no audit log entry, so the time of
 * input is kept nowhere. Failures are logged without the text and never reach the person who
 * rated.
 */
export async function saveFeedback(
  previous: FeedbackInput | undefined,
  next: FeedbackInput | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const dataset = feedbackDataset(env);
  if (!dataset) {
    return;
  }
  const { counts, texts } = feedbackRows(previous, next);
  if (counts.length === 0) {
    return;
  }
  let project: string;
  let token: string;
  try {
    project = await (await metadata('project/project-id', fetchFn)).text();
    token = (await (await metadata('instance/service-accounts/default/token', fetchFn)).json())
      .access_token;
  } catch (error) {
    logFailure(dataset, describe(error));
    return;
  }
  const tables = `${BIGQUERY}/projects/${project}/datasets/${dataset}/tables`;
  await Promise.all([
    insertAll(
      fetchFn,
      `${tables}/counts/insertAll`,
      token,
      `${dataset}.counts`,
      counts.map((json) => ({ insertId: randomUUID(), json })),
    ),
    texts.length > 0 &&
      insertAll(
        fetchFn,
        `${tables}/texts/insertAll`,
        token,
        `${dataset}.texts`,
        texts.map((json) => ({ insertId: json.id, json })),
      ),
  ]);
}
