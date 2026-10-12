import { feedbackBefore, feedbackRows, saveFeedback } from './store';

const ON = { FEEDBACK_DATASET: 'feedback' } as NodeJS.ProcessEnv;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LATE_EVENING = new Date('2026-10-08T23:30:00Z');

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

function bodyOf(calls: Call[], table: string) {
  const call = calls.find((c) => c.url.endsWith(`/tables/${table}/insertAll`));
  return call ? JSON.parse(String(call.init?.body)) : undefined;
}

describe('feedbackRows', () => {
  it('counts a first rating on its Berlin day', () => {
    expect(feedbackRows(null, { rating: 'thumbsDown', tag: 'inaccurate' }, LATE_EVENING)).toEqual({
      counts: [
        { date: '2026-10-09', rating: 'thumbsDown', reason: 'inaccurate', ratings: 1, texts: 0 },
      ],
      texts: [],
    });
  });

  it('counts a rating and its text saved together once each', () => {
    const rows = feedbackRows(null, { rating: 'thumbsDown', tag: 'other', text: 'zu lang' });
    expect(rows.counts).toEqual([expect.objectContaining({ ratings: 1, texts: 1 })]);
    expect(rows.texts).toHaveLength(1);
  });

  it('counts only the text when it is saved to the same rating', () => {
    const rows = feedbackRows(
      { rating: 'thumbsDown', tag: 'other' },
      { rating: 'thumbsDown', tag: 'other', text: '  Antwort zu lang.\nBitte kürzer.  ' },
      LATE_EVENING,
    );
    expect(rows).toEqual({
      counts: [{ date: '2026-10-09', rating: 'thumbsDown', reason: 'other', ratings: 0, texts: 1 }],
      texts: [
        {
          id: expect.stringMatching(UUID_V4),
          date: '2026-10-09',
          rating: 'thumbsDown',
          reason: 'other',
          text: 'Antwort zu lang.\nBitte kürzer.',
        },
      ],
    });
  });

  it('moves the count when the rating or reason changes', () => {
    const rows = feedbackRows(
      { rating: 'thumbsDown', tag: 'inaccurate', text: 'Dosis fehlte' },
      { rating: 'thumbsUp', tag: 'clear_well_written' },
      LATE_EVENING,
    );
    expect(rows).toEqual({
      counts: [
        { date: '2026-10-09', rating: 'thumbsDown', reason: 'inaccurate', ratings: -1, texts: 0 },
        {
          date: '2026-10-09',
          rating: 'thumbsUp',
          reason: 'clear_well_written',
          ratings: 1,
          texts: 0,
        },
      ],
      texts: [],
    });
  });

  it('takes the count back when a rating is withdrawn', () => {
    expect(feedbackRows({ rating: 'thumbsUp', tag: 'accurate_reliable' }, null)).toEqual({
      counts: [expect.objectContaining({ reason: 'accurate_reliable', ratings: -1, texts: 0 })],
      texts: [],
    });
  });

  it('adds nothing when the same feedback is saved again', () => {
    const feedback = { rating: 'thumbsDown', tag: 'other', text: 'zu lang' };
    expect(feedbackRows(feedback, { ...feedback })).toEqual({ counts: [], texts: [] });
  });

  it('moves no rating count when the stored feedback could not be read', () => {
    const rows = feedbackRows(undefined, { rating: 'thumbsDown', tag: 'other', text: 'zu lang' });
    expect(rows.counts).toEqual([expect.objectContaining({ ratings: 0, texts: 1 })]);
    expect(rows.texts).toHaveLength(1);
    expect(feedbackRows(undefined, { rating: 'thumbsUp', tag: 'accurate_reliable' })).toEqual({
      counts: [],
      texts: [],
    });
  });

  it('never copies other fields of the feedback', () => {
    const rows = feedbackRows(null, {
      rating: 'thumbsDown',
      tag: 'inaccurate',
      text: 'Dosis fehlte',
      user: 'u-123',
      conversationId: 'c-456',
    } as Parameters<typeof feedbackRows>[1]);
    expect(Object.keys(rows.counts[0]).sort()).toEqual([
      'date',
      'rating',
      'ratings',
      'reason',
      'texts',
    ]);
    expect(Object.keys(rows.texts[0]).sort()).toEqual(['date', 'id', 'rating', 'reason', 'text']);
    expect(JSON.stringify(rows)).not.toMatch(/u-123|c-456/);
  });

  it('gives every text row its own id', () => {
    const feedback = { rating: 'thumbsDown', tag: 'other', text: 'gleich' };
    expect(feedbackRows(null, feedback).texts[0].id).not.toBe(
      feedbackRows(null, feedback).texts[0].id,
    );
  });

  it('keeps no empty text', () => {
    const rows = feedbackRows(null, { rating: 'thumbsDown', tag: 'other', text: '   ' });
    expect(rows.texts).toEqual([]);
    expect(rows.counts).toEqual([expect.objectContaining({ ratings: 1, texts: 0 })]);
  });

  it('labels values outside the known ratings and reasons as unknown', () => {
    expect(feedbackRows(null, { rating: 'great', tag: { key: 'other' }, text: 'x' })).toMatchObject(
      {
        counts: [{ rating: 'unknown', reason: 'unknown' }],
        texts: [{ rating: 'unknown', reason: 'unknown' }],
      },
    );
  });

  it('caps the text at 500 characters', () => {
    const rows = feedbackRows(null, { rating: 'thumbsDown', tag: 'other', text: 'a'.repeat(600) });
    expect(rows.texts[0].text).toHaveLength(500);
  });

  it('masks e-mail addresses, dates and long numbers', () => {
    const rows = feedbackRows(null, {
      rating: 'thumbsDown',
      tag: 'other',
      text: 'Mail an max.muster@example.org, geb. 12.03.1960 und 1960-03-12, Fall 20241234',
    });
    expect(rows.texts[0].text).toBe('Mail an [E-Mail], geb. [Datum] und [Datum], Fall [Nummer]');
  });
});

describe('feedbackBefore', () => {
  it('reads nothing while FEEDBACK_DATASET is unset', async () => {
    const load = jest.fn();
    await expect(feedbackBefore(load, {})).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('returns the stored feedback, or null when there was none', async () => {
    const feedback = { rating: 'thumbsUp', tag: 'accurate_reliable' };
    await expect(feedbackBefore(async () => ({ feedback }), ON)).resolves.toEqual(feedback);
    await expect(feedbackBefore(async () => ({}), ON)).resolves.toBeNull();
  });

  it('returns undefined when the lookup fails', async () => {
    const load = jest.fn().mockRejectedValue(new Error('connection lost'));
    await expect(feedbackBefore(load, ON)).resolves.toBeUndefined();
  });
});

describe('saveFeedback', () => {
  it('sends nothing while FEEDBACK_DATASET is unset', async () => {
    const { fn } = fakeFetch();
    await saveFeedback(null, { rating: 'thumbsDown', tag: 'other', text: 'zu lang' }, {}, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('sends nothing when the update changes no count', async () => {
    const { fn } = fakeFetch();
    const feedback = { rating: 'thumbsUp', tag: 'clear_well_written' };
    await saveFeedback(feedback, { ...feedback }, ON, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('adds the count and text rows as the pod service account and logs nothing', async () => {
    const { calls, fn } = fakeFetch();
    const lines = await stderrLines(() =>
      saveFeedback(null, { rating: 'thumbsDown', tag: 'other', text: 'zu lang' }, ON, fn),
    );

    const tables =
      'https://bigquery.googleapis.com/bigquery/v2/projects/synthetic-project/datasets/feedback/tables';
    const inserts = calls.filter((call) => call.url.includes('/insertAll'));
    expect(inserts.map((call) => call.url).sort()).toEqual([
      `${tables}/counts/insertAll`,
      `${tables}/texts/insertAll`,
    ]);
    for (const call of inserts) {
      expect(new Headers(call.init?.headers).get('Authorization')).toBe('Bearer synthetic-token');
    }
    expect(bodyOf(calls, 'counts').rows).toEqual([
      {
        insertId: expect.stringMatching(UUID_V4),
        json: {
          date: expect.any(String),
          rating: 'thumbsDown',
          reason: 'other',
          ratings: 1,
          texts: 1,
        },
      },
    ]);
    const texts = bodyOf(calls, 'texts');
    expect(texts.rows).toHaveLength(1);
    expect(texts.rows[0].insertId).toBe(texts.rows[0].json.id);
    expect(lines).toEqual([]);
  });

  it('writes only counts for a rating without text', async () => {
    const { calls, fn } = fakeFetch();
    await saveFeedback(null, { rating: 'thumbsUp', tag: 'accurate_reliable' }, ON, fn);
    expect(calls.filter((call) => call.url.includes('/insertAll'))).toHaveLength(1);
    expect(bodyOf(calls, 'counts').rows).toHaveLength(1);
  });

  it('logs a refusal per table with its status, without the text or a user id', async () => {
    const { fn } = fakeFetch(() => new Response('denied', { status: 403 }));
    const lines = await stderrLines(() =>
      saveFeedback(
        null,
        { rating: 'thumbsDown', tag: 'other', text: 'TESTFALL-DIMEAS-01' },
        ON,
        fn,
      ),
    );
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        {
          severity: 'ERROR',
          message: '[feedback] Not saved to BigQuery feedback.counts: HTTP 403',
        },
        { severity: 'ERROR', message: '[feedback] Not saved to BigQuery feedback.texts: HTTP 403' },
      ]),
    );
  });

  it('logs rows BigQuery rejects', async () => {
    const { fn } = fakeFetch(() => Response.json({ insertErrors: [{ index: 0, errors: [] }] }));
    const lines = await stderrLines(() =>
      saveFeedback({ rating: 'thumbsDown', tag: 'other' }, null, ON, fn),
    );
    expect(lines).toEqual([
      {
        severity: 'ERROR',
        message: '[feedback] Not saved to BigQuery feedback.counts: row rejected',
      },
    ]);
  });

  it('logs a network failure with its cause and does not throw', async () => {
    const failure = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    });
    const fn = jest.fn().mockRejectedValue(failure) as unknown as typeof fetch;
    const lines = await stderrLines(() =>
      saveFeedback(null, { rating: 'thumbsDown', tag: 'other', text: 'zu lang' }, ON, fn),
    );
    expect(lines).toEqual([
      {
        severity: 'ERROR',
        message:
          '[feedback] Not saved to BigQuery feedback: fetch failed (ERR_TLS_CERT_ALTNAME_INVALID)',
      },
    ]);
  });
});
