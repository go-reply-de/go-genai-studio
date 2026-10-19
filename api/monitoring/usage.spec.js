const { createUsage } = require('./usage');

const HOUR = 3600e3;
/** 1 October 2026 00:00 in Berlin (CEST); the first hour of the month ends one hour later. */
const OCT_START = Date.parse('2026-09-30T22:00:00Z');
const NOV_START = Date.parse('2026-10-31T23:00:00Z');
const NOVEMBER = () => new Date('2026-11-05T10:00:00Z');
/** 16 October 2026, 15:20 in Berlin. */
const OCT_16 = () => new Date('2026-10-16T13:20:00Z');
const credentials = async () => ({ project: 'synthetic-project', token: 'synthetic-token' });

/** Which series a query asks for, by the metric it is about. */
function kind(query) {
  if (query.includes('clamp_min')) {
    for (const [name, metric] of [
      ['conversations', 'librechat_conversations_total'],
      ['messages', 'librechat_messages_total'],
      ['background', 'librechat_window_background_tokens_per_model'],
      ['chat', 'librechat_window_tokens_per_model'],
    ]) {
      if (query.includes(metric)) {
        return name;
      }
    }
  }
  for (const [name, metric] of [
    ['users', 'librechat_daily_unique_users'],
    ['weekly', 'librechat_weekly_unique_users'],
    ['recorded', 'librechat_window_unique_users'],
  ]) {
    if (query.includes(metric)) {
      return name;
    }
  }
  return query.includes('[1d]') ? 'first' : 'up';
}

/**
 * Answers query_range and instant queries like Cloud Monitoring. `series[kind]` lists
 * [labels, value(t)] where t is the end of the hour (or day, or running hour) a point stands for;
 * undefined leaves the point out.
 */
function monitoring(series = {}) {
  const calls = [];
  const fn = jest.fn(async (url, init) => {
    const params = new URLSearchParams(init.body);
    const instant = url.endsWith('/query');
    const time = Number(params.get('time')) * 1000;
    const call = {
      url,
      auth: init.headers.Authorization,
      query: params.get('query'),
      instant,
      start: instant ? time : Number(params.get('start')) * 1000,
      end: instant ? time : Number(params.get('end')) * 1000,
      step: Number(params.get('step')) * 1000,
    };
    call.kind = kind(call.query);
    calls.push(call);
    if (instant) {
      const result = (series[call.kind] || [])
        .map(([metric, at]) => ({ metric, value: [time / 1000, String(at(time))] }))
        .filter(({ value }) => value[1] !== 'undefined');
      return Response.json({ status: 'success', data: { resultType: 'vector', result } });
    }
    const result = (series[call.kind] || [])
      .map(([metric, at]) => {
        const values = [];
        for (let t = call.start; t <= call.end; t += call.step) {
          const v = at(t);
          if (v !== undefined) {
            values.push([t / 1000, String(v)]);
          }
        }
        return { metric, values };
      })
      .filter((s) => s.values.length);
    return Response.json({ status: 'success', data: { resultType: 'matrix', result } });
  });
  return { fn, calls };
}

const always = (v) => () => v;
/** The exporter has run since 5 August 2026 (Berlin). */
const SINCE_AUG_5 = Date.parse('2026-08-04T22:00:00Z');
const running = (t) => (t > SINCE_AUG_5 ? 1 : undefined);
const baseSeries = { up: [[{}, running]], first: [[{}, running]] };

function start(series, now = NOVEMBER) {
  const fake = monitoring({ ...baseSeries, ...series });
  const usage = createUsage({ credentials, fetchFn: fake.fn, now });
  return { usage, ...fake };
}

describe('usage from Cloud Monitoring', () => {
  it('asks Cloud Monitoring for the hours of the month in Berlin, with the pod token', async () => {
    const app = start({});
    await app.usage.view('2026-10');
    const messages = app.calls.find((c) => c.kind === 'messages' && c.start === OCT_START + HOUR);
    expect(messages.url).toBe(
      'https://monitoring.googleapis.com/v1/projects/synthetic-project/location/global/prometheus/api/v1/query_range',
    );
    expect(messages.auth).toBe('Bearer synthetic-token');
    expect(messages.end).toBe(NOV_START);
    expect(messages.step).toBe(HOUR);
  });

  it('counts only the rises of a stored count, every five minutes', async () => {
    const app = start({});
    await app.usage.view('2026-10');
    const query = (k) => app.calls.find((c) => c.kind === k).query;
    expect(query('messages')).toBe(
      'sum (sum_over_time(clamp_min(max (librechat_messages_total) - max (librechat_messages_total offset 5m), 0)[1h:5m]))',
    );
    // A label that appears while the exporter runs counts in full, such as a model after the wipe.
    expect(query('chat')).toBe(
      'sum by (model, type) (sum_over_time((' +
        'clamp_min(max by (model, type) (librechat_window_tokens_per_model{window="30d"})' +
        ' - max by (model, type) (librechat_window_tokens_per_model{window="30d"} offset 5m), 0)' +
        ' or ((max by (model, type) (librechat_window_tokens_per_model{window="30d"})' +
        ' unless max by (model, type) (librechat_window_tokens_per_model{window="30d"} offset 5m))' +
        ' and on() max(librechat_registered_users_total offset 5m)))[1h:5m]))',
    );
    expect(app.calls.some((c) => c.query.includes('librechat_messages_per_model_total'))).toBe(
      false,
    );
  });

  it('adds up the hours of each Berlin day, 25 when summer time ends', async () => {
    const app = start({ messages: [[{}, always(1)]], conversations: [[{}, always(0)]] });
    const view = await app.usage.view('2026-10');
    expect(view.days).toHaveLength(31);
    expect(view.days[0].messages).toBe(24);
    expect(view.days[24].messages).toBe(25);
    expect(view.days[25].messages).toBe(24);
    expect(view.totals.messages).toBe(31 * 24 + 1);
    expect(view.totals.conversations).toBe(0);
    expect(view.period).toEqual({ from: '2026-10-01', to: '2026-10-31', running: false });
  });

  it('ends a running month with its running hour, to the minute, and leaves later days empty', async () => {
    const app = start({ messages: [[{}, always(1)]] }, () => new Date('2026-10-16T13:20:40Z'));
    const view = await app.usage.view('2026-10');
    expect(view.period).toEqual({
      from: '2026-10-01',
      to: '2026-10-16',
      running: true,
      through: '2026-10-16T13:20:00.000Z',
    });
    const messages = app.calls.filter((c) => c.kind === 'messages');
    expect(messages.find((c) => !c.instant).end).toBe(Date.parse('2026-10-16T13:00:00Z'));
    const hour = messages.find((c) => c.instant);
    expect(hour.url).toBe(
      'https://monitoring.googleapis.com/v1/projects/synthetic-project/location/global/prometheus/api/v1/query',
    );
    expect(hour.end).toBe(Date.parse('2026-10-16T13:20:00Z'));
    expect(hour.query).toBe(
      'sum (sum_over_time(clamp_min(max (librechat_messages_total) - max (librechat_messages_total offset 5m), 0)[20m:5m]))',
    );
    expect(app.calls.find((c) => c.kind === 'up' && c.instant).query).toBe(
      'max(max_over_time(librechat_registered_users_total[20m]))',
    );
    // 15 full hours since midnight in Berlin, and the one running.
    expect(view.days[15].messages).toBe(16);
    expect(view.days.slice(16)).toEqual(Array(15).fill(null));
  });

  it('shows a day and its week from their first minutes', async () => {
    // Monday 19 October 2026, 00:20 in Berlin.
    const app = start(
      { messages: [[{}, always(1)]], weekly: [[{}, always(2)]] },
      () => new Date('2026-10-18T22:20:00Z'),
    );
    const view = await app.usage.view('2026-10');
    expect(view.period.to).toBe('2026-10-19');
    expect(view.days[18]).toMatchObject({ messages: 1 });
    expect(view.weeks.at(-1)).toMatchObject({ from: '2026-10-19', users: 2, running: true });
  });

  it('shows a month from its first minutes', async () => {
    // 1 November 2026, 00:20 in Berlin.
    const app = start({ messages: [[{}, always(1)]] }, () => new Date('2026-10-31T23:20:00Z'));
    const view = await app.usage.view('2026-11');
    expect(view.period).toEqual({
      from: '2026-11-01',
      to: '2026-11-01',
      running: true,
      through: '2026-10-31T23:20:00.000Z',
    });
    expect(view.days[0]).toMatchObject({ messages: 1 });
    // Cloud Monitoring refuses a range that ends before it starts.
    expect(app.calls.filter((c) => c.start > c.end)).toEqual([]);
  });

  it('asks for no running hour on the full hour', async () => {
    const app = start({}, () => new Date('2026-10-16T13:00:30Z'));
    const view = await app.usage.view('2026-10');
    expect(app.calls.filter((c) => c.instant)).toEqual([]);
    expect(view.period.through).toBe('2026-10-16T13:00:00.000Z');
  });

  it('has no figures for days before the exporter ran', async () => {
    const app = start({ messages: [[{}, always(2)]] });
    const view = await app.usage.view('2026-08');
    expect(view.days.slice(0, 4)).toEqual([null, null, null, null]);
    expect(view.days[4].messages).toBe(48);
  });

  it('takes the highest daily users of a day and of each Monday to Sunday week', async () => {
    // Users of the day rise through the day; the week's count rises through the week.
    const berlinDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin',
      day: 'numeric',
    });
    const dayOfMonth = (t) => Number(berlinDay.format(new Date(t - 1)));
    const app = start({
      users: [[{}, (t) => (new Date(t).getUTCHours() === 12 ? 7 : 3)]],
      weekly: [[{}, (t) => dayOfMonth(t)]],
    });
    const view = await app.usage.view('2026-10');
    expect(view.days[0].users).toBe(7);
    // Weeks belong to the month of their Thursday: 28 Sep to 1 Nov makes five October weeks.
    expect(view.weeks.map((w) => [w.from, w.to])).toEqual([
      ['2026-09-28', '2026-10-04'],
      ['2026-10-05', '2026-10-11'],
      ['2026-10-12', '2026-10-18'],
      ['2026-10-19', '2026-10-25'],
      ['2026-10-26', '2026-11-01'],
    ]);
    expect(view.weeks[1].users).toBe(11);
    expect(view.totals.weekly).toBe((30 + 11 + 18 + 25 + 31) / 5);
  });

  it('splits tokens by purpose and model, and only from the day they were recorded', async () => {
    const since16 = (v) => (t) => (t > Date.parse('2026-10-15T22:00:00Z') ? v : undefined);
    const app = start({
      recorded: [[{}, since16(1)]],
      chat: [
        [{ model: 'gemini-3.8-flash', type: 'input' }, since16(1000)],
        [{ model: 'gemini-3.8-flash', type: 'output' }, since16(10)],
      ],
      background: [
        [{ model: 'gemini-3.5-flash-lite', context: 'title', type: 'input' }, since16(20)],
        [{ model: 'gemini-3.5-flash-lite', context: 'web_grounding', type: 'output' }, since16(5)],
      ],
    });
    const view = await app.usage.view('2026-10');
    expect(view.days[14].tokens).toBeNull();
    expect(view.days[15].tokens).toEqual([
      ['chat', 'gemini-3.8-flash', 24000, 240],
      ['title', 'gemini-3.5-flash-lite', 480, 0],
      ['web_grounding', 'gemini-3.5-flash-lite', 0, 120],
    ]);
    // 16 to 31 October: 16 days, one of them 25 hours long.
    const hours = 16 * 24 + 1;
    expect(view.totals).toMatchObject({ input: hours * 1020, output: hours * 15, recorded: true });
  });

  it('orders the models of all months by their input, so their colours stay the same', async () => {
    const since16 = (v) => (t) => (t > Date.parse('2026-10-15T22:00:00Z') ? v : undefined);
    const app = start({
      recorded: [[{}, always(1)]],
      chat: [
        [{ model: 'gemini-b', type: 'input' }, always(5)],
        [{ model: 'gemini-a', type: 'input' }, since16(1000)],
      ],
      background: [[{ model: 'gemini-c', context: 'title', type: 'input' }, always(1)]],
    });
    const view = await app.usage.view('2026-09');
    expect(view.models).toEqual(['gemini-a', 'gemini-b', 'gemini-c']);
  });

  it('compares a running month with the same days of the month before', async () => {
    const app = start({ conversations: [[{}, always(1)]] }, OCT_16);
    const view = await app.usage.view('2026-10');
    expect(view.previous).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-16',
      conversations: 16 * 24,
      recorded: false,
    });
  });

  it('compares a finished month with all of the month before, and a first month with nothing', async () => {
    const app = start({ conversations: [[{}, always(1)]] });
    expect((await app.usage.view('2026-10')).previous).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
      conversations: 30 * 24,
    });
    expect((await app.usage.view('2026-08')).previous).toBeNull();
  });

  it('names only the days of the month before that have figures', async () => {
    const app = start({ conversations: [[{}, always(1)]] });
    // The exporter ran from 5 August, so September is compared with 5–31 August.
    expect((await app.usage.view('2026-09')).previous).toMatchObject({
      from: '2026-08-05',
      to: '2026-08-31',
      conversations: 27 * 24,
    });
  });

  it('lists the months since the exporter ran, newest first, with a total for each', async () => {
    const app = start({ conversations: [[{}, always(1)]] }, OCT_16);
    const view = await app.usage.view('2026-10');
    expect(view.months).toEqual(['2026-10', '2026-09', '2026-08']);
    expect(view.trend.map((m) => [m.month, m.conversations, m.running, m.firstDay])).toEqual([
      ['2026-08', 27 * 24, false, 5],
      ['2026-09', 30 * 24, false, 1],
      ['2026-10', 15 * 24 + 16, true, 1],
    ]);
  });

  it('keeps finished months and asks again for the running month after two minutes', async () => {
    let at = Date.parse('2026-10-16T13:20:00Z');
    const app = start({}, () => new Date(at));
    await app.usage.view('2026-10');
    const first = app.calls.length;
    await app.usage.view('2026-10');
    at += 2 * 60 * 1000 - 1;
    await app.usage.view('2026-10');
    expect(app.calls).toHaveLength(first);
    at += 1;
    await app.usage.view('2026-10');
    const again = app.calls.slice(first);
    expect(again.length).toBeGreaterThan(0);
    expect(
      again.every((c) => c.kind === 'first' || c.end > Date.parse('2026-10-01T00:00:00Z')),
    ).toBe(true);
  });

  it('answers from memory while the running month is asked again', async () => {
    let at = Date.parse('2026-10-16T13:20:00Z');
    const held = [];
    let hold = false;
    const fake = monitoring({ ...baseSeries, messages: [[{}, always(1)]] });
    const fetchFn = async (url, init) => {
      if (hold) {
        await new Promise((resolve) => held.push(resolve));
      }
      return fake.fn(url, init);
    };
    const usage = createUsage({ credentials, fetchFn, now: () => new Date(at) });
    const before = await usage.view('2026-10');
    at += 3600e3;
    hold = true;
    const stale = await usage.view('2026-10');
    expect(stale.period.through).toBe(before.period.through);
    hold = false;
    held.forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await usage.view('2026-10')).period.through).toBe('2026-10-16T14:20:00.000Z');
  });

  it('reads an answer without series, which Cloud Monitoring sends as null', async () => {
    const usage = createUsage({
      credentials,
      fetchFn: async () =>
        Response.json({ status: 'success', data: { resultType: 'matrix', result: null } }),
      now: NOVEMBER,
    });
    const view = await usage.view('2026-10');
    expect(view.days).toEqual(Array(31).fill(null));
    expect(view.months).toEqual(['2026-11']);
  });

  it('fails with the HTTP status of Cloud Monitoring', async () => {
    const usage = createUsage({
      credentials,
      fetchFn: async () => new Response('denied', { status: 403 }),
      now: NOVEMBER,
    });
    await expect(usage.view('2026-10')).rejects.toMatchObject({
      status: 502,
      message: 'Cloud Monitoring HTTP 403',
    });
  });
});

describe('usage for an interval', () => {
  it('adds up the days of an interval across months', async () => {
    const app = start({ messages: [[{}, always(1)]] }, OCT_16);
    const view = await app.usage.interval('2026-09-28', '2026-10-04');
    expect(view.period).toEqual({ from: '2026-09-28', to: '2026-10-04', running: false });
    expect(view.days.map((d) => d.messages)).toEqual(Array(7).fill(24));
    expect(view.totals.messages).toBe(7 * 24);
    expect(view.trend.map((m) => [m.month, m.firstDay, m.lastDay, m.messages])).toEqual([
      ['2026-09', 28, 30, 3 * 24],
      ['2026-10', 1, 4, 4 * 24],
    ]);
  });

  it('counts the weeks whose Thursday falls in the interval, with their calendar week', async () => {
    const app = start({ weekly: [[{}, always(2)]] }, OCT_16);
    // Friday 2 to Thursday 15 October: the week of 28 September has its Thursday outside.
    const view = await app.usage.interval('2026-10-02', '2026-10-15');
    expect(view.weeks.map((w) => [w.from, w.kw, w.users])).toEqual([
      ['2026-10-05', 41, 2],
      ['2026-10-12', 42, 2],
    ]);
  });

  it('ends an interval now, and leaves the days before the exporter empty', async () => {
    const app = start({ messages: [[{}, always(1)]] }, OCT_16);
    const view = await app.usage.interval('2026-08-01', '2026-12-31');
    expect(view.period).toEqual({
      from: '2026-08-01',
      to: '2026-10-16',
      running: true,
      through: '2026-10-16T13:20:00.000Z',
    });
    expect(view.days).toHaveLength(31 + 30 + 16);
    expect(view.days.slice(0, 4)).toEqual(Array(4).fill(null));
    expect(view.days[4].messages).toBe(24);
    expect(view.trend.map((m) => [m.month, m.firstDay, m.lastDay, m.running])).toEqual([
      ['2026-08', 5, 31, false],
      ['2026-09', 1, 30, false],
      ['2026-10', 1, 16, true],
    ]);
    expect(view.months).toEqual(['2026-10', '2026-09', '2026-08']);
  });

  it('answers an interval from the months already in memory', async () => {
    const app = start({}, OCT_16);
    await app.usage.view('2026-10');
    const before = app.calls.length;
    await app.usage.interval('2026-09-15', '2026-10-15');
    expect(app.calls).toHaveLength(before);
  });
});
