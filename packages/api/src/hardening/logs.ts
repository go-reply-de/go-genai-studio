/** Marks a console already wrapped, so a second start does not wrap it again. */
const STRIPPED = Symbol.for('librechat.hardening.consoleErrorWithoutRequests');

type RequestError = Error & {
  code?: unknown;
  status?: unknown;
  config?: unknown;
  response?: { status?: unknown };
};

/** Gaxios and axios errors keep the request they failed on in `config`, body included. */
function carriesRequest(value: unknown): value is RequestError {
  return value instanceof Error && 'config' in value;
}

/** What a log needs from such an error; the request and the response stay out. */
function withoutRequest(error: RequestError): Error {
  const stripped = new Error(error.message);
  stripped.name = error.name;
  stripped.stack = error.stack;
  const status = error.response?.status ?? error.status;
  return Object.assign(stripped, {
    ...(error.code != null && { code: error.code }),
    ...(status != null && { status }),
  });
}

/**
 * Strips the request from errors passed to console.error. @langchain/google-common logs every
 * Vertex call that fails without an HTTP status as the whole GaxiosError, and its config holds
 * the request body: the chat text.
 */
export function stripRequestsFromConsoleErrors(target: Console = console): void {
  const marked = target as Console & { [STRIPPED]?: true };
  if (marked[STRIPPED]) {
    return;
  }
  const original = target.error.bind(target);
  target.error = (...args: unknown[]) =>
    original(...args.map((arg) => (carriesRequest(arg) ? withoutRequest(arg) : arg)));
  marked[STRIPPED] = true;
}
