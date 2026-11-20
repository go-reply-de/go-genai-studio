import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';

export interface OverloadRetryOptions {
  /** Total tries, the first one included. */
  attempts?: number;
  /** Epoch milliseconds after which no further try starts. */
  deadline?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const STATUS_IN_MESSAGE = /(?:status code|got status:)\s*(\d{3})\b/;
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);
const OVERLOAD_STATUSES = new Set([429, 503]);
const OVERLOAD_INFO =
  'Die Server des KI-Anbieters sind gerade überlastet. Bitte versuchen Sie es in einer Minute erneut.';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 100 && value < 600 ? value : undefined;
}

/** A provider error can carry getters that throw, so each field is read on its own. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Reads the status where LangChain, fetch and the Vertex SDK put it: the response, the error,
 * the Vertex SDK's cause, then the message.
 */
export function errorStatus(error: unknown): number | undefined {
  const message = field(error, 'message');
  const fromMessage =
    typeof message === 'string' ? STATUS_IN_MESSAGE.exec(message)?.[1] : undefined;
  return (
    httpStatus(field(field(error, 'response'), 'status')) ??
    httpStatus(field(error, 'status')) ??
    httpStatus(field(field(error, 'cause'), 'code')) ??
    (fromMessage == null ? undefined : Number(fromMessage))
  );
}

/** Google's retry guidance for Vertex: 408, 429 and every 5xx. */
export function isRetryableStatus(status: number | undefined): boolean {
  return status != null && (RETRYABLE_CLIENT_STATUSES.has(status) || status >= 500);
}

/** Retries a retryable status with jittered exponential backoff: about 2 s, then about 4 s. */
export async function withOverloadRetry<T>(
  call: () => Promise<T>,
  {
    attempts = 3,
    deadline = Infinity,
    baseDelayMs = 2000,
    sleep = wait,
  }: OverloadRetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const status = errorStatus(error);
      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() / 2);
      if (attempt >= attempts || !isRetryableStatus(status) || Date.now() + delay > deadline) {
        throw error;
      }
      logger.warn(
        `[withOverloadRetry] Status ${status}, try ${attempt + 1} of ${attempts} in ${Math.round(delay)} ms`,
      );
      await sleep(delay);
    }
  }
}

/**
 * A Google error part, which the client shows as its `info` text alone, for a call that stayed
 * overloaded after its retries. Undefined for anything else, so the upstream message stands.
 */
export function overloadErrorText(error: unknown): string | undefined {
  const status = errorStatus(error);
  if (status == null || !OVERLOAD_STATUSES.has(status)) {
    return undefined;
  }
  return JSON.stringify({ type: ErrorTypes.GOOGLE_ERROR, info: OVERLOAD_INFO });
}
