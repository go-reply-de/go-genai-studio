const { createReport, upload } = require('./report');

const COMMENT = 'Laut Dr. Beispiel passt die Dosis seit dem 12.10. nicht mehr.';
const CHECKED = 'Herr Muster hat das schon geklärt.';
const PLAIN = 'Bitte kürzere Antworten.';

/** October 2026 as the feedback store answers it: 20 ratings, three comments, one checked. */
const october = {
  month: '2026-10',
  period: { from: '2026-10-01', to: '2026-10-31', running: false },
  current: { rated: 20, up: 15, down: 5, texts: 3 },
  previous: { from: '2026-09-01', to: '2026-09-30', rated: 18, up: 12, down: 6, texts: 2 },
  days: Array.from({ length: 31 }, () => [0, 0]),
  reasons: {
    thumbsDown: { inaccurate: 3, other: 2 },
    thumbsUp: { accurate_reliable: 15 },
  },
  texts: [
    {
      id: 'a',
      date: '2026-10-14',
      rating: 'thumbsDown',
      reason: 'inaccurate',
      text: COMMENT,
      reviewed: false,
    },
    {
      id: 'b',
      date: '2026-10-09',
      rating: 'thumbsDown',
      reason: 'other',
      text: CHECKED,
      reviewed: true,
    },
    {
      id: 'c',
      date: '2026-10-02',
      rating: 'thumbsUp',
      reason: 'other',
      text: PLAIN,
      reviewed: false,
    },
  ],
};

const day = (conversations) => ({
  conversations,
  messages: conversations * 7,
  users: 3,
  tokens: [
    ['chat', 'gemini-3.8-flash', conversations * 1000, conversations * 50],
    ['web_grounding', 'gemini-3.5-flash-lite', conversations * 30, conversations * 5],
  ],
});

/** October in the Nutzung tab's shape, with token data on every day. */
const usageOctober = {
  month: '2026-10',
  period: { from: '2026-10-01', to: '2026-10-31', running: false },
  days: Array.from({ length: 31 }, (_, i) => day(i === 0 ? 40 : 40)),
  weeks: [
    { thursday: 1, kw: 40, from: '2026-09-28', to: '2026-10-04', users: 74 },
    { thursday: 8, kw: 41, from: '2026-10-05', to: '2026-10-11', users: 77 },
    { thursday: 15, kw: 42, from: '2026-10-12', to: '2026-10-18', users: 81 },
    { thursday: 22, kw: 43, from: '2026-10-19', to: '2026-10-25', users: 82 },
    { thursday: 29, kw: 44, from: '2026-10-26', to: '2026-11-01', users: 79 },
  ],
  totals: { conversations: 1240, messages: 8680, input: 1270080, output: 61845, recorded: true },
  previous: {
    from: '2026-09-01',
    to: '2026-09-30',
    conversations: 1071,
    messages: 7506,
    input: 0,
    output: 0,
    recorded: false,
  },
  months: ['2026-11', '2026-10', '2026-09', '2026-08'],
  trend: [
    {
      month: '2026-08',
      running: false,
      firstDay: 4,
      conversations: 721,
      input: 0,
      recorded: false,
    },
    {
      month: '2026-09',
      running: false,
      firstDay: 1,
      conversations: 1071,
      input: 0,
      recorded: false,
    },
    {
      month: '2026-10',
      running: false,
      firstDay: 1,
      conversations: 1240,
      input: 1270080,
      recorded: true,
    },
    {
      month: '2026-11',
      running: true,
      firstDay: 1,
      conversations: 12,
      input: 9000,
      recorded: true,
    },
  ],
  models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
};

/** 28 September to 1 November, the whole weeks of October: 10 a day, 100 in September, 1000 on 1 November. */
const octoberWeeks = {
  period: { from: '2026-09-28', to: '2026-11-01', running: false },
  days: Array.from({ length: 35 }, (_, i) => {
    if (i < 3) {
      return day(100);
    }
    return day(i === 34 ? 1000 : 10);
  }),
};

const ENV = {
  APP_TITLE: 'DiMeAs',
  ENVIRONMENT: 'sov-prod',
  REPORT_BUCKET: 'genai-portal-sov-prod-monitoring-reports',
  PAGE_URL: 'https://admin.example.org/monitoring/',
  USAGE_TOKEN_SPLIT: 'purpose',
};
/** 06:00 on 1 November 2026 in Berlin, when the CronJob runs. */
const NOVEMBER_1 = () => new Date('2026-11-01T05:00:00Z');

function setUp({ env = ENV, now = NOVEMBER_1, feedbackMonth = october, written = 'ok' } = {}) {
  const calls = { feedback: [], usage: [], interval: [], uploads: [], logs: [] };
  const feedback = {
    monthView: async (y, m) => {
      calls.feedback.push([y, m]);
      return feedbackMonth;
    },
  };
  const usage = {
    view: async (key) => {
      calls.usage.push(key);
      return usageOctober;
    },
    interval: async (from, to) => {
      calls.interval.push([from, to]);
      return octoberWeeks;
    },
  };
  const report = createReport({
    env,
    now,
    feedback,
    usage,
    upload: async (name, html) => {
      calls.uploads.push({ name, html });
      return written;
    },
    log: (severity, message, fields) => calls.logs.push({ severity, message, ...fields }),
  });
  return { report, calls };
}

describe('monitoring report', () => {
  it('reports the month before in Berlin, or the one asked for', async () => {
    const app = setUp();
    await app.report.run();
    expect(app.calls.feedback).toEqual([[2026, 10]]);
    expect(app.calls.usage).toEqual(['2026-10']);
    expect(app.calls.uploads[0].name).toBe('reports/monatsbericht-2026-10.html');

    const asked = setUp({ env: { ...ENV, REPORT_MONTH: '2026-09' } });
    await asked.report.run();
    expect(asked.calls.usage).toEqual(['2026-09']);
  });

  it('writes the figures of both tabs and never a comment', async () => {
    const app = setUp();
    await app.report.run();
    const { html } = app.calls.uploads[0];
    for (const figure of [
      'DiMeAs Monatsbericht Oktober 2026',
      'sov-prod',
      '1.240',
      '8.680',
      '75,0 %',
      'KW 42',
      'Ungenaue oder falsche Antwort',
      'Websuche-Tool',
      'https://admin.example.org/monitoring/?m=2026-10',
    ]) {
      expect([figure, html.includes(figure)]).toEqual([figure, true]);
    }
    for (const text of [COMMENT, CHECKED, PLAIN, 'Dr. Beispiel', 'Herr Muster']) {
      expect([text, html.includes(text)]).toEqual([text, false]);
    }
  });

  it('counts only the comments with possible personal data that nobody has checked', async () => {
    const app = setUp();
    await app.report.run();
    const line = app.calls.logs.find((l) => l.message === 'monitoring report written');
    // The first comment has a title before a name and a date; the second one is checked.
    expect(line.monitoringReport).toMatchObject({ texts: '3', unchecked: '1' });
  });

  it('logs the figures the mail needs, without any comment', async () => {
    const app = setUp();
    await app.report.run();
    const line = app.calls.logs.find((l) => l.message === 'monitoring report written');
    expect(line).toMatchObject({
      severity: 'NOTICE',
      monitoringReport: {
        month: 'Oktober 2026',
        conversations: '1.240',
        conversationsBefore: '1.071',
        messages: '8.680',
        users: '74 bis 82',
        ratings: '20',
        up: '15',
        down: '5',
        positive: '75,0 %',
        texts: '3',
        unchecked: '1',
        input: '1,27 Mio.',
        object: 'reports/monatsbericht-2026-10.html',
        page: 'https://admin.example.org/monitoring/?m=2026-10',
        // Whole lines for the mail, so the alert needs only a few values.
        usage:
          '1.240 Unterhaltungen begonnen (Vormonat 1.071), 8.680 Nachrichten, 74 bis 82 Nutzer je Woche',
        feedback: '20 Bewertungen (15 Daumen hoch, 5 Daumen runter), 75,0 % positiv',
        comments: '3 eingegangen, davon 1 mit möglichen Personenangaben noch nicht geprüft',
      },
    });
    expect(JSON.stringify(app.calls.logs)).not.toMatch(/Beispiel|Muster|kürzere/);
  });

  it('shows no positive share below 10 ratings and says when tokens were not recorded', async () => {
    const app = setUp({
      feedbackMonth: { ...october, current: { rated: 4, up: 3, down: 1, texts: 0 }, texts: [] },
    });
    await app.report.run();
    const { html } = app.calls.uploads[0];
    expect(html).toContain('erst ab 10 Bewertungen');
    // September had no token data.
    expect(html).toContain('nicht erfasst');
    const line = app.calls.logs.find((l) => l.message === 'monitoring report written');
    expect(line.monitoringReport.positive).toBe('–');
  });

  it('shows a tiny share as under 0.1 per cent and marks a week that is still running', async () => {
    const app = setUp();
    usageOctober.weeks.at(-1).running = true;
    try {
      await app.report.run();
    } finally {
      delete usageOctober.weeks.at(-1).running;
    }
    const { html } = app.calls.uploads[0];
    // The web search tool has 3 % of the answers' input here; titles are not in the data.
    expect(html).toContain('2,9 %');
    expect(html).toMatch(/KW 44<small>[^<]*bisher<\/small>/);
    const line = app.calls.logs.find((l) => l.message === 'monitoring report written');
    // A running week is left out of the range, as on the page.
    expect(line.monitoringReport.users).toBe('74 bis 82');
  });

  it('writes a share that rounds to nothing as under 0.1 per cent', async () => {
    const { renderReport } = require('./report');
    const html = renderReport(
      {
        key: '2026-10',
        previousKey: '2026-09',
        feedback: {
          current: october.current,
          previous: october.previous,
          reasons: october.reasons,
          unchecked: 0,
        },
        usage: {
          totals: { conversations: 1, messages: 1, input: 10001, output: 0, recorded: true },
          previous: null,
          days: [1],
          weeks: [],
          users: null,
          tokens: [
            { key: 'chat', input: 10000, output: 0 },
            { key: 'title', input: 1, output: 0 },
          ],
          split: 'purpose',
        },
      },
      { env: ENV, created: 'heute', page: ENV.PAGE_URL },
    );
    expect(html).toContain('&lt; 0,1 %');
  });

  it('counts conversations and users per whole week, also on days in the neighbouring months', async () => {
    const app = setUp();
    await app.report.run();
    expect(app.calls.interval).toEqual([['2026-09-28', '2026-11-01']]);
    const { html } = app.calls.uploads[0];
    expect(html).not.toContain('<svg');
    expect(html).toContain('<th>Woche</th><th>Unterhaltungen</th><th>Nutzer</th>');
    // KW 40 has three September days, KW 44 the first of November.
    expect(html).toMatch(/KW 40<small>28\.9\.–4\.10\.<\/small><\/td><td>340<\/td><td>74<\/td>/);
    expect(html).toMatch(/KW 41<small>[^<]*<\/small><\/td><td>70<\/td><td>77<\/td>/);
    expect(html).toMatch(/KW 44<small>26\.10\.–1\.11\.<\/small><\/td><td>1\.060<\/td><td>79<\/td>/);
    // Newest week first, as on the page.
    expect(html.indexOf('KW 44<small>')).toBeLessThan(html.indexOf('KW 40<small>'));
  });

  it('keeps a report that already exists and sends nothing', async () => {
    const app = setUp({ written: 'exists' });
    await app.report.run();
    expect(app.calls.logs).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        message: 'monitoring report already exists, not overwritten',
        object: 'reports/monatsbericht-2026-10.html',
      }),
    ]);
  });
});

describe('report upload', () => {
  const credentials = async () => ({ project: 'synthetic-project', token: 'synthetic-token' });

  it('adds the file to the bucket only if it does not exist yet', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    };
    expect(
      await upload(
        { fetchFn, credentials, bucket: 'reports-bucket' },
        'reports/x.html',
        '<p>x</p>',
      ),
    ).toBe('ok');
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(
      'https://storage.googleapis.com/upload/storage/v1/b/reports-bucket/o',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      uploadType: 'media',
      name: 'reports/x.html',
      ifGenerationMatch: '0',
    });
    expect(calls[0].init.headers).toEqual({
      Authorization: 'Bearer synthetic-token',
      'Content-Type': 'text/html; charset=utf-8',
    });
  });

  it('answers exists when the file is already there and fails on anything else', async () => {
    const answer = (status) => async () => new Response('', { status });
    expect(await upload({ fetchFn: answer(412), credentials, bucket: 'b' }, 'n', 'h')).toBe(
      'exists',
    );
    await expect(
      upload({ fetchFn: answer(403), credentials, bucket: 'b' }, 'n', 'h'),
    ).rejects.toThrow('Cloud Storage HTTP 403');
  });
});
