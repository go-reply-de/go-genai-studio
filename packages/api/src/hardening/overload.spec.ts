import { ErrorTypes } from 'librechat-data-provider';
import { errorStatus, withOverloadRetry, isRetryableStatus, overloadErrorText } from './overload';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const OVERLOAD_INFO = 'Der KI-Dienst ist gerade ausgelastet – bitte in einer Minute erneut senden.';

/** How LangChain's Google client reports a refused request. */
const langchainError = (status: number): Error =>
  Object.assign(new Error(`Google request failed with status code ${status}`), {
    response: { status },
  });

/** How the Vertex SDK reports a 4xx: the status sits on the cause. */
const vertexClientError = (status: number): Error =>
  Object.assign(new Error(`[VertexAI.ClientError]: got status: ${status} Too Many Requests. {}`), {
    name: 'ClientError',
    cause: { code: status, status: 'RESOURCE_EXHAUSTED' },
  });

/** How the Vertex SDK reports a 5xx: only the message carries the status. */
const vertexServerError = (status: number): Error =>
  new Error(`[VertexAI.GoogleGenerativeAIError]: got status: ${status} Service Unavailable. {}`);

const noSleep = jest.fn(async (_ms: number): Promise<void> => undefined);

describe('errorStatus', () => {
  it.each([
    ['LangChain', langchainError(429), 429],
    ['Vertex SDK 4xx', vertexClientError(429), 429],
    ['Vertex SDK 5xx', vertexServerError(503), 503],
    ['message-only', new Error('Google request failed with status code 429'), 429],
  ])('reads the status of a %s error', (_label, error, status) => {
    expect(errorStatus(error)).toBe(status);
  });

  it('ignores a gRPC status name', () => {
    expect(errorStatus({ status: 'RESOURCE_EXHAUSTED', message: 'Resource exhausted' })).toBe(
      undefined,
    );
  });

  it('has no status for a non-error', () => {
    expect(errorStatus(undefined)).toBeUndefined();
    expect(errorStatus('429')).toBeUndefined();
  });
});

describe('isRetryableStatus', () => {
  it.each([408, 429, 500, 503, 504])('retries %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, undefined])('does not retry %s', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});

describe('withOverloadRetry', () => {
  it('retries an overloaded call and returns the retry', async () => {
    const call = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(vertexClientError(429))
      .mockResolvedValueOnce('ok');

    await expect(withOverloadRetry(call, { sleep: noSleep })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('backs off about 2 s, then about 4 s', async () => {
    const sleep = jest.fn(async (_ms: number): Promise<void> => undefined);
    const call = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(vertexServerError(503))
      .mockRejectedValueOnce(vertexServerError(503))
      .mockResolvedValueOnce('ok');

    await withOverloadRetry(call, { sleep });

    const [[first], [second]] = sleep.mock.calls;
    expect(first).toBeGreaterThanOrEqual(1500);
    expect(first).toBeLessThanOrEqual(2500);
    expect(second).toBeGreaterThanOrEqual(3000);
    expect(second).toBeLessThanOrEqual(5000);
  });

  it('gives up after three tries with the last error', async () => {
    const error = vertexClientError(429);
    const call = jest.fn<Promise<string>, []>().mockRejectedValue(error);

    await expect(withOverloadRetry(call, { sleep: noSleep })).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('does not retry a rejected request', async () => {
    const error = langchainError(400);
    const call = jest.fn<Promise<string>, []>().mockRejectedValue(error);

    await expect(withOverloadRetry(call, { sleep: noSleep })).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('starts no retry that would end past the deadline', async () => {
    const error = vertexClientError(429);
    const call = jest.fn<Promise<string>, []>().mockRejectedValue(error);

    await expect(
      withOverloadRetry(call, { deadline: Date.now() + 1000, sleep: noSleep }),
    ).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('overloadErrorText', () => {
  it.each([429, 503])('words a lasting %i as a Google error the client shows as is', (status) => {
    const text = overloadErrorText(langchainError(status));

    expect(JSON.parse(text ?? '{}')).toEqual({
      type: ErrorTypes.GOOGLE_ERROR,
      info: OVERLOAD_INFO,
    });
  });

  it('leaves every other error to the upstream message', () => {
    expect(overloadErrorText(langchainError(400))).toBeUndefined();
    expect(overloadErrorText(langchainError(500))).toBeUndefined();
    expect(overloadErrorText(new Error('boom'))).toBeUndefined();
  });
});
