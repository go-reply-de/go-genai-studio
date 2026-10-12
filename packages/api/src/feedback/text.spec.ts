import { feedbackTextRow, saveFeedbackText } from './text';

const ON = { FEEDBACK_TEXT_TABLE: 'feedback.feedback_texts' } as NodeJS.ProcessEnv;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Call = { url: string; init?: RequestInit };

/** Answers like the GKE metadata server and BigQuery would, and records every request. */
function fakeFetch(
  bigquery: () => Response = () => Response.json({ kind: 'bigquery#tableDataInsertAllResponse' }),
) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/project/project-id')) {
      return new Response('synthetic-project');
    }
    if (String(url).endsWith('/service-accounts/default/token')) {
      return Response.json({ access_token: 'synthetic-token', expires_in: 3599 });
    }
    return bigquery();
  });
  return { calls, fn: fn as unknown as typeof fetch };
}

/** Runs `run` and returns the JSON lines it wrote to stderr. */
async function stderrLines(run: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines.map((line) => JSON.parse(line));
}

describe('feedbackTextRow', () => {
  it('keeps the day, rating, reason and text, plus a random id', () => {
    const row = feedbackTextRow(
      { rating: 'thumbsDown', tag: 'other', text: '  Antwort zu lang.\nBitte kürzer.  ' },
      new Date('2026-10-08T23:30:00Z'),
    );
    expect(row).toEqual({
      id: expect.stringMatching(UUID_V4),
      date: '2026-10-09',
      rating: 'thumbsDown',
      reason: 'other',
      text: 'Antwort zu lang.\nBitte kürzer.',
    });
  });

  it('never copies other fields of the feedback', () => {
    const row = feedbackTextRow({
      rating: 'thumbsDown',
      tag: 'inaccurate',
      text: 'Dosis fehlte',
      user: 'u-123',
      conversationId: 'c-456',
    } as Parameters<typeof feedbackTextRow>[0]);
    expect(Object.keys(row ?? {}).sort()).toEqual(['date', 'id', 'rating', 'reason', 'text']);
    expect(JSON.stringify(row)).not.toMatch(/u-123|c-456/);
  });

  it('gives every row its own id', () => {
    const feedback = { rating: 'thumbsDown', tag: 'other', text: 'gleich' };
    expect(feedbackTextRow(feedback)?.id).not.toBe(feedbackTextRow(feedback)?.id);
  });

  it('skips ratings without text', () => {
    expect(feedbackTextRow({ rating: 'thumbsUp', tag: 'clear_well_written' })).toBeUndefined();
    expect(feedbackTextRow({ rating: 'thumbsDown', tag: 'other', text: '   ' })).toBeUndefined();
    expect(feedbackTextRow(null)).toBeUndefined();
    expect(feedbackTextRow(undefined)).toBeUndefined();
  });

  it('labels values outside the known ratings and reasons as unknown', () => {
    expect(feedbackTextRow({ rating: 'great', tag: { key: 'other' }, text: 'x' })).toMatchObject({
      rating: 'unknown',
      reason: 'unknown',
    });
  });

  it('caps the text at 500 characters', () => {
    const row = feedbackTextRow({ rating: 'thumbsDown', tag: 'other', text: 'a'.repeat(600) });
    expect(row?.text).toHaveLength(500);
  });

  it('masks e-mail addresses, dates and long numbers', () => {
    const row = feedbackTextRow({
      rating: 'thumbsDown',
      tag: 'other',
      text: 'Mail an max.muster@example.org, geb. 12.03.1960 und 1960-03-12, Fall 20241234',
    });
    expect(row?.text).toBe('Mail an [E-Mail], geb. [Datum] und [Datum], Fall [Nummer]');
  });
});

describe('saveFeedbackText', () => {
  it('sends nothing while FEEDBACK_TEXT_TABLE is unset', async () => {
    const { fn } = fakeFetch();
    await saveFeedbackText({ rating: 'thumbsDown', tag: 'other', text: 'zu lang' }, {}, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('sends nothing for a rating without text', async () => {
    const { fn } = fakeFetch();
    await saveFeedbackText({ rating: 'thumbsUp', tag: 'clear_well_written' }, ON, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('adds one row as the pod service account and logs nothing', async () => {
    const { calls, fn } = fakeFetch();
    const lines = await stderrLines(() =>
      saveFeedbackText({ rating: 'thumbsDown', tag: 'other', text: 'zu lang' }, ON, fn),
    );

    const insert = calls.find((call) => call.url.includes('/insertAll'));
    expect(insert?.url).toBe(
      'https://bigquery.googleapis.com/bigquery/v2/projects/synthetic-project/datasets/feedback/tables/feedback_texts/insertAll',
    );
    expect(new Headers(insert?.init?.headers).get('Authorization')).toBe('Bearer synthetic-token');
    const body = JSON.parse(String(insert?.init?.body));
    expect(body.rows).toHaveLength(1);
    expect(Object.keys(body.rows[0].json).sort()).toEqual([
      'date',
      'id',
      'rating',
      'reason',
      'text',
    ]);
    expect(body.rows[0].insertId).toBe(body.rows[0].json.id);
    expect(lines).toEqual([]);
  });

  it('logs a refusal with its status, without the text or a user id', async () => {
    const { fn } = fakeFetch(() => new Response('denied', { status: 403 }));
    const lines = await stderrLines(() =>
      saveFeedbackText({ rating: 'thumbsDown', tag: 'other', text: 'TESTFALL-DIMEAS-01' }, ON, fn),
    );
    expect(lines).toEqual([
      { severity: 'ERROR', message: '[feedback] Free text not saved to BigQuery: HTTP 403' },
    ]);
  });

  it('logs rows BigQuery rejects', async () => {
    const { fn } = fakeFetch(() => Response.json({ insertErrors: [{ index: 0, errors: [] }] }));
    const lines = await stderrLines(() =>
      saveFeedbackText({ rating: 'thumbsDown', tag: 'other', text: 'zu lang' }, ON, fn),
    );
    expect(lines).toEqual([
      { severity: 'ERROR', message: '[feedback] Free text not saved to BigQuery: row rejected' },
    ]);
  });

  it('logs a network failure with its cause and does not throw', async () => {
    const failure = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    });
    const fn = jest.fn().mockRejectedValue(failure) as unknown as typeof fetch;
    const lines = await stderrLines(() =>
      saveFeedbackText({ rating: 'thumbsDown', tag: 'other', text: 'zu lang' }, ON, fn),
    );
    expect(lines).toEqual([
      {
        severity: 'ERROR',
        message:
          '[feedback] Free text not saved to BigQuery: fetch failed (ERR_TLS_CERT_ALTNAME_INVALID)',
      },
    ]);
  });
});
