import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';

/** Where LangChain, fetch and the Vertex SDK put the HTTP status of a failed model call. */
interface StatusError {
  name?: string;
  code?: string | number;
  status?: string | number;
  message?: string;
  response?: { status?: number };
  cause?: { code?: string | number };
}

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
const OVERLOAD_INFO = 'Der KI-Dienst ist gerade ausgelastet – bitte in einer Minute erneut senden.';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function httpStatus(value: string | number | undefined): number | undefined {
  return typeof value === 'number' && value >= 100 && value < 600 ? value : undefined;
}

/** Reads the status from the response, then the Vertex SDK's cause, then the message. */
export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { response, status, cause, message } = error as StatusError;
  const fromMessage =
    typeof message === 'string' ? STATUS_IN_MESSAGE.exec(message)?.[1] : undefined;
  return (
    httpStatus(response?.status) ??
    httpStatus(status) ??
    httpStatus(cause?.code) ??
    (fromMessage == null ? undefined : Number(fromMessage))
  );
}

/** Google's retry guidance for Vertex: 408, 429 and every 5xx. */
export function isRetryableStatus(status: number | undefined): boolean {
  return status != null && (RETRYABLE_CLIENT_STATUSES.has(status) || status >= 500);
}

function isAbort({ name, code, message = '' }: StatusError): boolean {
  return name === 'AbortError' || code === 'ECONNABORTED' || /^(Cancel|AbortError)/.test(message);
}

/**
 * LangChain's default handler retries a 429 only when it carries Retry-After. This one retries
 * every retryable status and, like the default, fails at once on aborts and other 4xx.
 */
export function retryVertexOverload(error: Error): void {
  const status = errorStatus(error);
  if (isAbort(error as StatusError) || (status != null && !isRetryableStatus(status))) {
    throw error;
  }
  if (status != null) {
    logger.warn(`[retryVertexOverload] Vertex answered ${status}`);
  }
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
