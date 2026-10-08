import { FEEDBACK_RATINGS, FEEDBACK_REASON_KEYS } from 'librechat-data-provider';
import { isEnabled } from '~/utils/common';

/** The feedback box stops at 500 characters; a hand-made request can send more. */
const MAX_TEXT_LENGTH = 500;

/** Best effort against identifiers the disclaimer asks people to leave out. */
const MASKS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g, '[E-Mail]'],
  [/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g, '[Datum]'],
  [/\d{6,}/g, '[Nummer]'],
];

export type FeedbackTextInput = { rating?: unknown; tag?: unknown; text?: unknown } | null;

/** FEEDBACK_TEXT_LOG also tells the client to show the feedback dialog's privacy hint. */
export function isFeedbackTextLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.FEEDBACK_TEXT_LOG);
}

function known<T extends string>(values: readonly T[], value: unknown): T | 'unknown' {
  return values.includes(value as T) ? (value as T) : 'unknown';
}

/**
 * FEEDBACK_TEXT_LOG prints a rating's free text as one JSON line. It takes the feedback alone,
 * so no user, chat or message id can reach the line; Cloud Logging stores it as jsonPayload,
 * where the feedback dashboard's log metric counts it per reason and text.
 */
export function logFeedbackText(
  feedback: FeedbackTextInput | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isFeedbackTextLogEnabled(env) || typeof feedback?.text !== 'string') {
    return;
  }
  let text = feedback.text.trim().slice(0, MAX_TEXT_LENGTH);
  for (const [pattern, mask] of MASKS) {
    text = text.replace(pattern, mask);
  }
  if (!text) {
    return;
  }
  const line = {
    severity: 'INFO',
    feedbackText: {
      rating: known(FEEDBACK_RATINGS, feedback.rating),
      tag: known(FEEDBACK_REASON_KEYS, feedback.tag),
      text,
    },
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
