const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createReview } = require('./server');

/** October 2026 has ended, so it is compared with all of September. */
const NOVEMBER = () => new Date('2026-11-05T10:00:00Z');
const ENV = { FEEDBACK_DATASET: 'feedback', APP_TITLE: 'DiMeAs', ENVIRONMENT: 'sov-dev' };

const REVIEWER = { 'X-Goog-Authenticated-User-Email': 'accounts.google.com:reviewer@example.org' };
const ACTION = { ...REVIEWER, 'X-Feedback-Review': '1', 'Content-Type': 'application/json' };
const ID = '3f1c2a9e-1111-4a6b-9c1d-000000000001';
const OTHER = '3f1c2a9e-1111-4a6b-9c1d-000000000002';

const cells = (...values) => ({ f: values.map((v) => ({ v: String(v) })) });
const MONTHS_QUERY = 'SELECT FORMAT_DATE';

/** Answers like BigQuery: the months with feedback (one rating each unless given), counts, texts. */
const bigQuery =
  ({ months = [], counts = [], texts = [] } = {}) =>
  (body) => {
    let rows = texts;
    if (body.query.startsWith(MONTHS_QUERY)) {
      rows = months.map((month) => (Array.isArray(month) ? cells(...month) : cells(month, 1)));
    } else if (body.query.includes('.counts`')) {
      rows = counts;
    }
    return Response.json({ jobComplete: true, numDmlAffectedRows: '1', rows });
  };

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
async function start(answer, { now = NOVEMBER, fontDirs } = {}) {
  const fake = fakeFetch(answer);
  const review = createReview({ env: ENV, fetchFn: fake.fn, now, ...(fontDirs && { fontDirs }) });
  const server = http.createServer((req, res) => review.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/feedback`;
  const request = (path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });
  return { ...fake, request, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Waits up to half a second for background work. */
async function waitFor(check) {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
    expect(res.headers.get('content-security-policy')).toContain("font-src 'self'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const page = await res.text();
    expect(page).toContain('<script src="theme.js"></script>');
    expect(page).toContain('<script src="app.js" defer></script>');
    expect(page).toContain('<script src="hints.js" defer></script>');
    expect((await app.request('/theme.js', { headers: REVIEWER })).status).toBe(200);
    expect((await app.request('/hints.js', { headers: REVIEWER })).status).toBe(200);
    expect((await app.request('/i18n.js', { headers: REVIEWER })).status).toBe(200);
    expect((await app.request('', { headers: REVIEWER })).headers.get('location')).toBe(
      '/feedback/',
    );
  });

  it('writes the reviewer, the app and the month into the page', async () => {
    app = await start(bigQuery());
    const page = await (
      await app.request('/?m=2026-09', {
        headers: { 'X-Goog-Authenticated-User-Email': 'accounts.google.com:a&b.rev@example.org' },
      })
    ).text();
    expect(page).toContain('<b id="app">DiMeAs</b>');
    expect(page).toContain('<span class="badge" id="env">sov-dev</span>');
    expect(page).toContain('Angemeldet als a&amp;b.rev@example.org');
    expect(page).toContain('<span class="avatar" id="avatar" aria-hidden="true">AB</span>');
    expect(page).toContain('data-month="2026-09"');
    expect(page).toContain('<span id="month-title">September 2026</span>');
    expect(page).toContain('<title>September 2026 · DiMeAs Feedback</title>');
    expect(page).not.toContain('{{');

    const fallback = await (await app.request('/?m=2026-13', { headers: REVIEWER })).text();
    expect(fallback).toContain('data-month="2026-11"');
  });

  it('speaks English when the reviewer chose it or the browser prefers it', async () => {
    app = await start(bigQuery());
    const page = async (headers) =>
      (await app.request('/?m=2026-10', { headers: { ...REVIEWER, ...headers } })).text();
    const chosen = await page({ Cookie: 'other=1; feedback-lang=en' });
    expect(chosen).toContain('<html lang="en">');
    expect(chosen).toContain('<span id="month-title">October 2026</span>');
    expect(chosen).toContain('Signed in as reviewer@example.org');
    expect(chosen).toMatch(/data-lang="en"[^>]*aria-pressed="true"/);
    expect(chosen).not.toContain('{{');
    expect(await page({ 'Accept-Language': 'en-GB,en;q=0.9,de;q=0.8' })).toContain('lang="en"');
    expect(await page({ 'Accept-Language': 'fr-FR,de;q=0.7,en;q=0.5' })).toContain('lang="de"');
    expect(await page({ 'Accept-Language': 'en-GB', Cookie: 'feedback-lang=de' })).toContain(
      '<html lang="de">',
    );
    const german = await page({});
    expect(german).toContain('<span id="month-title">Oktober 2026</span>');
    expect(german).toContain('Angemeldet als reviewer@example.org');
    expect(german).not.toContain('{{');
  });

  it('starts the month queries while the page itself is served', async () => {
    app = await start(bigQuery({ months: ['2026-11'] }));
    expect((await app.request('/', { headers: REVIEWER })).status).toBe(200);
    await waitFor(() => app.queries.length === 3);
    expect(app.queries).toHaveLength(3);
    expect((await app.request('/api/month?m=2026-11', { headers: REVIEWER })).status).toBe(200);
    expect(app.queries).toHaveLength(3);
  });

  it("serves LibreChat's Inter from the page itself and nothing else from the font folder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fonts-'));
    for (const name of [
      'Inter-Regular.woff2',
      'Inter-SemiBold.woff2',
      'Inter-Bold.woff2',
      'other.woff2',
    ]) {
      fs.writeFileSync(path.join(dir, name), `synthetic ${name}`);
    }
    app = await start(() => Response.json({ jobComplete: true }), {
      fontDirs: ['/nonexistent', dir],
    });
    const font = await app.request('/fonts/Inter-SemiBold.woff2', { headers: REVIEWER });
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(await font.text()).toBe('synthetic Inter-SemiBold.woff2');
    expect((await app.request('/fonts/other.woff2', { headers: REVIEWER })).status).toBe(404);
    expect((await app.request('/fonts/Inter-Regular.woff2')).status).toBe(403);
    fs.rmSync(dir, { recursive: true });
  });

  it('compares a running month with the same days of the month before', async () => {
    app = await start(
      bigQuery({
        counts: [
          cells('2026-10-02', 'thumbsUp', 'accurate_reliable', 3, 1),
          cells('2026-09-05', 'thumbsUp', 'accurate_reliable', 4, 1),
          cells('2026-09-30', 'thumbsDown', 'other', 9, 2),
        ],
      }),
      { now: () => new Date('2026-10-11T22:30:00Z') },
    );
    const data = await (await app.request('/api/month?m=2026-10', { headers: REVIEWER })).json();
    // 22:30 UTC on the 11th is already the 12th in Berlin, so only 1–12 September counts.
    expect(data.period).toEqual({ from: '2026-10-01', to: '2026-10-12', running: true });
    expect(data.previous).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-12',
      rated: 4,
      down: 0,
      texts: 1,
    });
    expect(data.current).toEqual({ rated: 3, up: 3, down: 0, texts: 1 });
  });

  it('sums a month and the one before from the counts and lists its texts', async () => {
    app = await start(
      bigQuery({
        months: ['2026-10', '2026-09'],
        counts: [
          cells('2026-10-01', 'thumbsUp', 'accurate_reliable', 5, 0),
          cells('2026-10-01', 'thumbsDown', 'inaccurate', 2, 1),
          cells('2026-10-31', 'thumbsDown', 'other', 1, 1),
          cells('2026-09-30', 'thumbsUp', 'accurate_reliable', 7, 2),
          cells('2026-10-02', 'unknown', 'unknown', 3, 0),
        ],
        texts: [
          cells(ID, '2026-10-01', 'thumbsDown', 'inaccurate', 'zu lang', true),
          // A text no reviewer has marked yet: BigQuery answers NULL.
          { f: [...cells(OTHER, '2026-10-01', 'thumbsUp', 'other', 'gut').f, { v: null }] },
        ],
      }),
    );
    const res = await app.request('/api/month?m=2026-10', { headers: REVIEWER });
    const data = await res.json();

    expect(data).toMatchObject({
      month: '2026-10',
      period: { from: '2026-10-01', to: '2026-10-31', running: false },
      current: { rated: 8, up: 5, down: 3, texts: 2 },
      previous: { to: '2026-09-30', rated: 7, up: 7, down: 0, texts: 2 },
      reasons: { thumbsUp: { accurate_reliable: 5 }, thumbsDown: { inaccurate: 2, other: 1 } },
      texts: [
        {
          id: ID,
          date: '2026-10-01',
          rating: 'thumbsDown',
          reason: 'inaccurate',
          text: 'zu lang',
          reviewed: true,
        },
        { id: OTHER, text: 'gut', reviewed: false },
      ],
    });
    expect(data.days).toHaveLength(31);
    expect(data.days[0]).toEqual([5, 2]);
    expect(data.days[30]).toEqual([0, 1]);

    const counts = app.queries.find(
      (q) => q.query.includes('.counts`') && !q.query.startsWith(MONTHS_QUERY),
    );
    const texts = app.queries.find((q) => q.query.includes('.texts`'));
    expect(counts.url).toBe(
      'https://bigquery.googleapis.com/bigquery/v2/projects/synthetic-project/queries',
    );
    expect(counts.auth).toBe('Bearer synthetic-token');
    expect(counts.jobCreationMode).toBe('JOB_CREATION_OPTIONAL');
    expect(counts.query).toContain('`synthetic-project.feedback.counts`');
    expect(counts.queryParameters).toEqual([
      { name: 'first', parameterType: { type: 'DATE' }, parameterValue: { value: '2026-09-01' } },
      { name: 'last', parameterType: { type: 'DATE' }, parameterValue: { value: '2026-10-31' } },
    ]);
    expect(texts.query).toContain(
      'SELECT id, date, rating, reason, text, reviewed FROM `synthetic-project.feedback.texts`',
    );
    expect(texts.queryParameters.map((p) => p.parameterValue.value)).toEqual([
      '2026-10-01',
      '2026-10-31',
    ]);
  });

  it('reads further result pages', async () => {
    app = await start(() => Response.json({ jobComplete: true, rows: [] }));
    app.fn.mockImplementation(async (url, init) => {
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
      const texts = JSON.parse(init.body).query.includes('.texts`');
      return Response.json({
        jobComplete: true,
        jobReference: { jobId: 'job-1', location: 'europe-west3' },
        pageToken: texts ? 'next' : undefined,
        rows: texts ? [cells(ID, '2026-10-01', 'thumbsUp', 'other', 'eins')] : [],
      });
    });
    const data = await (await app.request('/api/month?m=2026-10', { headers: REVIEWER })).json();
    expect(data.texts.map((t) => t.text)).toEqual(['eins', 'zwei']);
    expect(app.fn.mock.calls.map(([url]) => url)).toContain(
      'https://bigquery.googleapis.com/bigquery/v2/projects/synthetic-project/queries/job-1?location=europe-west3&pageToken=next',
    );
  });

  it('lists the months with feedback and their ratings, newest first, and the running month', async () => {
    app = await start(
      bigQuery({
        months: [
          ['2026-10', 72],
          ['2026-08', 16],
        ],
      }),
    );
    const data = await (await app.request('/api/month?m=2026-10', { headers: REVIEWER })).json();
    expect(data.months).toEqual(['2026-11', '2026-10', '2026-08']);
    expect(data.ratingsByMonth).toEqual({ '2026-11': 0, '2026-10': 72, '2026-08': 16 });
    expect(app.queries.find((q) => q.query.startsWith(MONTHS_QUERY)).query).toBe(
      "SELECT FORMAT_DATE('%Y-%m', date) AS month, " +
        "SUM(IF(rating IN ('thumbsUp', 'thumbsDown'), ratings, 0)) AS rated " +
        'FROM `synthetic-project.feedback.counts` GROUP BY month ' +
        'HAVING SUM(ratings) != 0 OR SUM(texts) != 0 ORDER BY month DESC',
    );

    await app.close();
    app = await start(bigQuery({ months: ['2026-11', '2026-10'] }));
    const again = await (await app.request('/api/month?m=2026-11', { headers: REVIEWER })).json();
    expect(again.months).toEqual(['2026-11', '2026-10']);
  });

  it('asks BigQuery for the months, counts and texts at the same time', async () => {
    let open = 0;
    let most = 0;
    app = await start(async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 20));
      open -= 1;
      return Response.json({ jobComplete: true, rows: [] });
    });
    expect((await app.request('/api/month?m=2026-10', { headers: REVIEWER })).status).toBe(200);
    expect(most).toBe(3);
    const metadata = app.fn.mock.calls.filter(([url]) => url.includes('metadata.google.internal'));
    expect(metadata).toHaveLength(2);
  });

  it('keeps a finished month for five minutes or until a text changes, the running month for seconds', async () => {
    let clock = Date.parse('2026-11-05T10:00:00Z');
    app = await start(
      bigQuery({
        months: ['2026-10'],
        texts: [cells(ID, '2026-10-01', 'thumbsDown', 'other', 'zu lang')],
      }),
      { now: () => new Date(clock) },
    );
    const month = async (m) =>
      (await app.request(`/api/month?m=${m}`, { headers: REVIEWER })).json();
    await month('2026-10');
    expect(app.queries).toHaveLength(3);
    expect((await month('2026-10')).texts).toHaveLength(1);
    expect(app.queries).toHaveLength(3);

    await stdoutLines(() =>
      app.request(`/api/texts/${ID}/delete`, { method: 'POST', headers: ACTION }),
    );
    await month('2026-10');
    // The delete, then counts and texts again; the list of months stays in memory.
    expect(app.queries).toHaveLength(6);

    // Requests a few seconds apart share the running month, like a page and its first poll.
    await month('2026-11');
    await month('2026-11');
    expect(app.queries).toHaveLength(8);
    clock += 6000;
    await month('2026-11');
    expect(app.queries).toHaveLength(10);

    // After five minutes the finished month and the list of months are asked again.
    clock += 5 * 60 * 1000;
    await month('2026-10');
    expect(app.queries).toHaveLength(13);
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

  it('marks a text as checked for everyone and takes that back, logged without the text', async () => {
    app = await start(() => Response.json({ jobComplete: true, numDmlAffectedRows: '1' }));
    const review = (body) =>
      app.request(`/api/texts/${ID}/review`, {
        method: 'POST',
        headers: ACTION,
        body: JSON.stringify(body),
      });
    const lines = await stdoutLines(async () => {
      expect((await review({ reviewed: true })).status).toBe(200);
      expect(await (await review({ reviewed: false })).json()).toEqual({
        ok: true,
        reviewed: false,
      });
      expect((await review({ reviewed: 'yes' })).status).toBe(400);
      expect((await review({})).status).toBe(400);
    });
    expect(app.queries).toHaveLength(2);
    expect(app.queries[0].query).toBe(
      'UPDATE `synthetic-project.feedback.texts` SET reviewed = @reviewed WHERE id = @id',
    );
    const flag = (value) => ({
      name: 'reviewed',
      parameterType: { type: 'BOOL' },
      parameterValue: { value },
    });
    const id = { name: 'id', parameterType: { type: 'STRING' }, parameterValue: { value: ID } };
    expect(app.queries.map((q) => q.queryParameters)).toEqual([
      [id, flag('true')],
      [id, flag('false')],
    ]);
    expect(lines).toEqual([
      { severity: 'NOTICE', message: 'feedback text reviewed', id: ID, by: 'reviewer@example.org' },
      {
        severity: 'NOTICE',
        message: 'feedback text review withdrawn',
        id: ID,
        by: 'reviewer@example.org',
      },
    ]);
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
