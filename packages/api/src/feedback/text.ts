import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { FEEDBACK_RATINGS, FEEDBACK_REASON_KEYS } from 'librechat-data-provider';

/** The feedback box stops at 500 characters; a hand-made request can send more. */
const MAX_TEXT_LENGTH = 500;

/** Best effort against identifiers the disclaimer asks people to leave out. */
const MASKS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g, '[E-Mail]'],
  [/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g, '[Datum]'],
  [/\d{6,}/g, '[Nummer]'],
];

/** The regional endpoint keeps the text inside europe-west3 in transit as well. */
const BIGQUERY = 'https://bigquery.europe-west3.rep.googleapis.com/bigquery/v2';
const METADATA = 'http://metadata.google.internal/computeMetadata/v1';

export type FeedbackTextInput = { rating?: unknown; tag?: unknown; text?: unknown } | null;

export type FeedbackTextRow = {
  id: string;
  date: string;
  rating: string;
  reason: string;
  text: string;
};

/** FEEDBACK_TEXT_TABLE (dataset.table) also tells the client to show the feedback dialog's privacy hint. */
export function feedbackTextTable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const table = env.FEEDBACK_TEXT_TABLE?.trim();
  return table ? table : undefined;
}

export function isFeedbackTextStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return feedbackTextTable(env) != null;
}

function known<T extends string>(values: readonly T[], value: unknown): T | 'unknown' {
  return values.includes(value as T) ? (value as T) : 'unknown';
}

/**
 * The row for a rating's free text: the day, never the time; rating, reason and the masked text;
 * and a random id that only addresses the row. It takes the feedback alone, so no user, chat or
 * message id can reach it.
 */
export function feedbackTextRow(
  feedback: FeedbackTextInput | undefined,
  now: Date = new Date(),
): FeedbackTextRow | undefined {
  if (typeof feedback?.text !== 'string') {
    return undefined;
  }
  let text = feedback.text.trim().slice(0, MAX_TEXT_LENGTH);
  for (const [pattern, mask] of MASKS) {
    text = text.replace(pattern, mask);
  }
  if (!text) {
    return undefined;
  }
  return {
    id: randomUUID(),
    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(now),
    rating: known(FEEDBACK_RATINGS, feedback.rating),
    reason: known(FEEDBACK_REASON_KEYS, feedback.tag),
    text,
  };
}

async function metadata(path: string, fetchFn: typeof fetch): Promise<Response> {
  return fetchFn(`${METADATA}/${path}`, { headers: { 'Metadata-Flavor': 'Google' } });
}

/**
 * Adds a rating's free text to the BigQuery table in FEEDBACK_TEXT_TABLE, as the pod's Workload
 * Identity service account; reviewers delete or clean single rows there. Streaming inserts leave
 * no audit log entry, so the time of input is kept nowhere. Failures are logged without the text
 * and never reach the person who rated.
 */
export async function saveFeedbackText(
  feedback: FeedbackTextInput | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const table = feedbackTextTable(env);
  const row = table ? feedbackTextRow(feedback) : undefined;
  if (!table || !row) {
    return;
  }
  const [dataset, name] = table.split('.');
  try {
    const project = await (await metadata('project/project-id', fetchFn)).text();
    const token = await (await metadata('instance/service-accounts/default/token', fetchFn)).json();
    const res = await fetchFn(
      `${BIGQUERY}/projects/${project}/datasets/${dataset}/tables/${name}/insertAll`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rows: [{ insertId: row.id, json: row }] }),
      },
    );
    const body = res.ok ? await res.json() : undefined;
    if (!res.ok || body?.insertErrors?.length) {
      logger.error(`[feedback] Free text not saved to BigQuery (HTTP ${res.status})`);
    }
  } catch (error) {
    logger.error('[feedback] Free text not saved to BigQuery', (error as Error)?.message);
  }
}
