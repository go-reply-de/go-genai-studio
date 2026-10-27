import { inspect } from 'util';
import { stripRequestsFromConsoleErrors } from './logs';

/** A console that records each console.error call as the text Node would print. */
function recordingConsole(): { target: Console; lines: string[] } {
  const lines: string[] = [];
  const target = {
    error: (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' '));
    },
  } as unknown as Console;
  return { target, lines };
}

/** Shaped like the GaxiosError google-common logs when a Vertex call times out. */
function failedVertexCall(): Error {
  return Object.assign(
    new Error(
      'request to https://aiplatform.googleapis.com/v1/generateContent failed, reason: socket hang up',
    ),
    {
      name: 'GaxiosError',
      code: 'ECONNRESET',
      config: {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Synthetischer Testfall Lungenembolie' }] }],
        }),
      },
    },
  );
}

describe('stripRequestsFromConsoleErrors', () => {
  it('logs a failed Vertex call without its request body', () => {
    const { target, lines } = recordingConsole();
    stripRequestsFromConsoleErrors(target);

    target.error('failedAttemptHandler', failedVertexCall());

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('failedAttemptHandler');
    expect(lines[0]).toContain('socket hang up');
    expect(lines[0]).toContain('ECONNRESET');
    expect(lines[0]).not.toContain('Lungenembolie');
    expect(lines[0]).not.toMatch(/config:|body:/);
  });

  it('keeps the response status and drops the response', () => {
    const { target, lines } = recordingConsole();
    stripRequestsFromConsoleErrors(target);
    const error = Object.assign(new Error('Too Many Requests'), {
      config: { data: 'Synthetischer Testfall' },
      response: { status: 429, data: 'Synthetischer Testfall' },
    });

    target.error(error);

    expect(lines[0]).toContain('429');
    expect(lines[0]).not.toContain('Synthetischer Testfall');
  });

  it('passes other arguments through unchanged', () => {
    const { target, lines } = recordingConsole();
    stripRequestsFromConsoleErrors(target);
    const plain = new Error('plain failure');

    target.error('context', plain, { id: 1 });

    expect(lines[0]).toBe(['context', inspect(plain), inspect({ id: 1 })].join(' '));
  });

  it('wraps a console only once', () => {
    const calls: unknown[][] = [];
    const target = { error: (...args: unknown[]) => calls.push(args) } as unknown as Console;
    stripRequestsFromConsoleErrors(target);
    const wrapped = target.error;

    stripRequestsFromConsoleErrors(target);
    target.error('once');

    expect(target.error).toBe(wrapped);
    expect(calls).toEqual([['once']]);
  });
});
