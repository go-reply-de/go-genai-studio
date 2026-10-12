const http = require('http');
const { createReview } = require('./server');

const REVIEWER = { 'X-Goog-Authenticated-User-Email': 'accounts.google.com:reviewer@example.org' };
const ACTION = { ...REVIEWER, 'X-Feedback-Review': '1', 'Content-Type': 'application/json' };
const ID = '3f1c2a9e-1111-4a6b-9c1d-000000000001';

const cells = (...values) => ({ f: values.map((v) => ({ v: String(v) })) });

/** Answers like the GKE metadata server and BigQuery would, and records every query. */
function fakeFetch(answer) {
  const queries = [];
  const fn = jest.fn(async (url, init) => {
    if (url.endsWith('/project/project-id')) {
      return new Response('synthetic-project');
    }
    if (url.endsWith('/service-accounts/default/token')) {
      return Response.json({ access_token: 'synthetic-token', expires_in: 3599 });
    }
    const body = JSON.parse(init.body);
    queries.push({ url, auth: init.headers.Authorization, ...body });
    return answer(body);
  });
  return { fn, queries };
}

/** Starts the review server on a free port; returns a fetch bound to it. */
async function start(
  answer,
  env = { FEEDBACK_DATASET: 'feedback', APP_TITLE: 'DiMeAs', ENVIRONMENT: 'sov-dev' },
) {
  const fake = fakeFetch(answer);
  const review = createReview({ env, fetchFn: fake.fn });
  const server = http.createServer((req, res) => review.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/feedback`;
  const request = (path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });
  return { ...fake, request, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Runs `run` and returns the JSON lines it wrote to stdout. */
async function stdoutLines(run) {
  const lines = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
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

describe('feedback review server', () => {
  let app;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('answers health checks without IAP and nothing else', async () => {
    app = await start(() => Response.json({ jobComplete: true }));
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/')).status).toBe(403);
    expect((await app.request('/api/month?m=2026-10')).status).toBe(403);
    expect(app.fn).not.toHaveBeenCalled();
  });

  it('serves the page with a strict content security policy', async () => {
    app = await start(() => Response.json({ jobComplete: true }));
    const res = await app.request('/', { headers: REVIEWER });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('<script src="app.js" defer></script>');
    expect((await app.request('', { headers: REVIEWER })).headers.get('location')).toBe(
      '/feedback/',
    );
  });

  it('sums a month and the one before from the counts and lists its texts', async () => {
    app = await start((body) =>
      Response.json(
        body.query.includes('.counts`')
          ? {
              jobComplete: true,
              rows: [
                cells('2026-10-01', 'thumbsUp', 'accurate_reliable', 5, 0),
                cells('2026-10-01', 'thumbsDown', 'inaccurate', 2, 1),
                cells('2026-10-31', 'thumbsDown', 'other', 1, 1),
                cells('2026-09-30', 'thumbsUp', 'accurate_reliable', 7, 2),
                cells('2026-10-02', 'unknown', 'unknown', 3, 0),
              ],
            }
          : {
              jobComplete: true,
              rows: [cells(ID, '2026-10-01', 'thumbsDown', 'inaccurate', 'zu lang')],
            },
      ),
    );
    const res = await app.request('/api/month?m=2026-10', { headers: REVIEWER });
    const data = await res.json();

    expect(data).toMatchObject({
      application: 'DiMeAs',
      environment: 'sov-dev',
      month: '2026-10',
      label: 'Oktober 2026',
      user: 'reviewer@example.org',
      current: { rated: 8, up: 5, down: 3, texts: 2 },
      previous: { label: 'September', rated: 7, up: 7, down: 0, texts: 2 },
      reasons: { thumbsUp: { accurate_reliable: 5 }, thumbsDown: { inaccurate: 2, other: 1 } },
      texts: [
        { id: ID, date: '2026-10-01', rating: 'thumbsDown', reason: 'inaccurate', text: 'zu lang' },
      ],
    });
    expect(data.days).toHaveLength(31);
    expect(data.days[0]).toEqual([5, 2]);
    expect(data.days[30]).toEqual([0, 1]);

    const [counts, texts] = app.queries;
    expect(counts.url).toBe(
      'https://bigquery.googleapis.com/bigquery/v2/projects/synthetic-project/queries',
    );
    expect(counts.auth).toBe('Bearer synthetic-token');
    expect(counts.query).toContain('`synthetic-project.feedback.counts`');
    expect(counts.queryParameters).toEqual([
      { name: 'first', parameterType: { type: 'DATE' }, parameterValue: { value: '2026-09-01' } },
      { name: 'last', parameterType: { type: 'DATE' }, parameterValue: { value: '2026-10-31' } },
    ]);
    expect(texts.query).toContain('`synthetic-project.feedback.texts`');
    expect(texts.queryParameters.map((p) => p.parameterValue.value)).toEqual([
      '2026-10-01',
      '2026-10-31',
    ]);
  });

  it('reads further result pages', async () => {
    let page = 0;
    app = await start(() => Response.json({ jobComplete: true, rows: [] }));
    app.fn.mockImplementation(async (url) => {
      if (url.endsWith('/project/project-id')) {
        return new Response('synthetic-project');
      }
      if (url.endsWith('/service-accounts/default/token')) {
        return Response.json({ access_token: 'synthetic-token', expires_in: 3599 });
      }
      if (url.includes('pageToken')) {
        return Response.json({
          jobComplete: true,
          rows: [cells(ID, '2026-10-02', 'thumbsUp', 'other', 'zwei')],
        });
      }
      page += 1;
      return Response.json({
        jobComplete: true,
        jobReference: { jobId: 'job-1', location: 'europe-west3' },
        pageToken: page === 2 ? 'next' : undefined,
        rows: page === 2 ? [cells(ID, '2026-10-01', 'thumbsUp', 'other', 'eins')] : [],
      });
    });
    const data = await (await app.request('/api/month?m=2026-10', { headers: REVIEWER })).json();
    expect(data.texts.map((t) => t.text)).toEqual(['eins', 'zwei']);
    expect(app.fn.mock.calls.map(([url]) => url)).toContain(
      'https://bigquery.googleapis.com/bigquery/v2/projects/synthetic-project/queries/job-1?location=europe-west3&pageToken=next',
    );
  });

  it('refuses a malformed month', async () => {
    app = await start(() => Response.json({ jobComplete: true }));
    expect((await app.request('/api/month?m=2026-13', { headers: REVIEWER })).status).toBe(400);
  });

  it('deletes a text by id and logs the id and reviewer, not the text', async () => {
    app = await start(() => Response.json({ jobComplete: true, numDmlAffectedRows: '1' }));
    const lines = await stdoutLines(async () => {
      expect(
        (await app.request(`/api/texts/${ID}/delete`, { method: 'POST', headers: ACTION })).status,
      ).toBe(200);
    });
    expect(app.queries[0].query).toBe(
      'DELETE FROM `synthetic-project.feedback.texts` WHERE id = @id',
    );
    expect(app.queries[0].queryParameters).toEqual([
      { name: 'id', parameterType: { type: 'STRING' }, parameterValue: { value: ID } },
    ]);
    expect(lines).toEqual([
      { severity: 'NOTICE', message: 'feedback text deleted', id: ID, by: 'reviewer@example.org' },
    ]);
  });

  it('cleans a text, capped, or replaces it with the marker when emptied', async () => {
    app = await start(() => Response.json({ jobComplete: true, numDmlAffectedRows: '1' }));
    const clean = (text) =>
      stdoutLines(async () => {
        await app.request(`/api/texts/${ID}/clean`, {
          method: 'POST',
          headers: ACTION,
          body: JSON.stringify({ text }),
        });
      });
    const lines = await clean('  Kontraindikation fehlte  ');
    await clean('   ');
    await clean('a'.repeat(600));

    const texts = app.queries.map(
      (q) => q.queryParameters.find((p) => p.name === 'text').parameterValue.value,
    );
    expect(texts).toEqual(['Kontraindikation fehlte', '[entfernt]', 'a'.repeat(500)]);
    expect(app.queries[0].query).toBe(
      'UPDATE `synthetic-project.feedback.texts` SET text = @text WHERE id = @id',
    );
    expect(JSON.stringify(lines)).not.toContain('Kontraindikation');
  });

  it('turns away actions without the page header, with a bad id or for a missing row', async () => {
    app = await start(() => Response.json({ jobComplete: true, numDmlAffectedRows: '0' }));
    expect(
      (await app.request(`/api/texts/${ID}/delete`, { method: 'POST', headers: REVIEWER })).status,
    ).toBe(403);
    expect(
      (await app.request('/api/texts/abc/delete', { method: 'POST', headers: ACTION })).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/texts/${ID}/delete`, { method: 'POST', headers: ACTION })).status,
    ).toBe(404);
    expect(app.queries).toHaveLength(1);
  });

  it('answers 409 while the row is still in the streaming buffer', async () => {
    app = await start(
      () =>
        new Response(
          'UPDATE or DELETE statement over table would affect rows in the streaming buffer',
          {
            status: 400,
          },
        ),
    );
    const lines = await stdoutLines(async () => {
      expect(
        (await app.request(`/api/texts/${ID}/delete`, { method: 'POST', headers: ACTION })).status,
      ).toBe(409);
    });
    expect(lines).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        id: ID,
        by: 'reviewer@example.org',
        detail: 'streaming buffer',
      }),
    ]);
  });
});
