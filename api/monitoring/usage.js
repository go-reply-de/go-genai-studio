/**
 * The Nutzung tab's figures: the metrics exporter's series in Cloud Monitoring, per Berlin day.
 *
 * MongoDB keeps chats for a week only, so the exporter reports what is stored right now and its
 * counts fall to zero every Sunday night. A day's figure is the sum of the rises of such a count;
 * Cloud Monitoring keeps the series for 24 months. Nothing here knows who did what: the exporter
 * reports counts only, and agents are never told apart.
 */
const MONITORING = 'https://monitoring.googleapis.com/v1/projects';
const HOUR = 3600e3;
const DAY = 24 * HOUR;
/** A running month is asked again after this; finished months do not change. */
const RUNNING_MS = 5 * 60 * 1000;
/** The months list follows the exporter's first day, so it changes rarely. */
const MONTHS_MS = 6 * HOUR;
const PARALLEL = 6;
/** Always reported while the exporter runs. */
const UP = 'librechat_registered_users_total';

class UsageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The rises of a stored count per hour, sampled every five minutes; deletions and the weekly wipe
 * lower the count and are left out. Every minute takes Cloud Monitoring ten times as long and
 * would add only what is deleted within the same five minutes, such as a quick test chat.
 * The exporter only reports a label while it has data, so a label that appears while the exporter
 * runs, such as a model after the wipe, is new in full; after an outage it is not counted again.
 */
function rises(metric, by = []) {
  if (!by.length) {
    return `sum (sum_over_time(clamp_min(max (${metric}) - max (${metric} offset 5m), 0)[1h:5m]))`;
  }
  const group = ` by (${by.join(', ')})`;
  const now = `max${group} (${metric})`;
  const before = `max${group} (${metric} offset 5m)`;
  return (
    `sum${group} (sum_over_time((clamp_min(${now} - ${before}, 0)` +
    ` or ((${now} unless ${before}) and on() max(${UP} offset 5m)))[1h:5m]))`
  );
}

const highest = (metric) => `max(max_over_time(${metric}[1h]))`;

const QUERIES = {
  up: highest(UP),
  conversations: rises('librechat_conversations_total'),
  messages: rises('librechat_messages_total'),
  chat: rises('librechat_window_tokens_per_model{window="30d"}', ['model', 'type']),
  background: rises('librechat_window_background_tokens_per_model{window="30d"}', [
    'model',
    'context',
    'type',
  ]),
  users: highest('librechat_daily_unique_users'),
  // Reported only while the exporter counts tokens from LibreChat's transactions.
  recorded: highest('librechat_window_unique_users{window="30d"}'),
};
const WEEKLY = highest('librechat_weekly_unique_users');

const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** A calendar date as YYYY-MM-DD; days past the month's end roll over. */
const isoDate = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const berlinDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' });
const berlinParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
});
/** The Berlin date of the hour that ends at `t`. */
const hourDate = (t) => berlinDate.format(new Date(t - 1));

function offset(t) {
  const p = Object.fromEntries(
    berlinParts.formatToParts(new Date(t)).map(({ type, value }) => [type, Number(value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60000) * 60000;
}

/** Midnight in Berlin starting that date; the second pass corrects a guess across a DST change. */
function midnight(y, m, d) {
  const utc = Date.UTC(y, m - 1, d);
  return utc - offset(utc - offset(utc));
}

/** Mondays to Sundays whose Thursday falls in the month, as ISO weeks belong to the year of theirs. */
function weeksOf(y, m) {
  const weekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const weeks = [];
  for (let thursday = 1 + ((11 - weekday) % 7); thursday <= daysIn(y, m); thursday += 7) {
    weeks.push({
      thursday,
      from: isoDate(y, m, thursday - 3),
      to: isoDate(y, m, thursday + 3),
      start: midnight(y, m, thursday - 3),
      end: midnight(y, m, thursday + 4),
    });
  }
  return weeks;
}

/** Answers first, then the background requests by purpose, each by model. */
const byPurpose = ([pa, ma], [pb, mb]) =>
  (pb === 'chat') - (pa === 'chat') || pa.localeCompare(pb) || ma.localeCompare(mb);

const sum = (values) => values.reduce((a, b) => a + b, 0);
const average = (values) => (values.length ? sum(values) / values.length : null);

/** A month's figures up to a day: all of it by default, the same days of it for a comparison. */
function totals(month, upTo = month.days.length) {
  const days = month.days.slice(0, upTo).filter(Boolean);
  const counted = days.filter((d) => d.tokens);
  const weeks = month.weeks
    .filter((w) => w.users !== null && w.thursday <= upTo)
    .map((w) => w.users);
  return {
    conversations: sum(days.map((d) => d.conversations)),
    messages: sum(days.map((d) => d.messages)),
    input: sum(counted.flatMap((d) => d.tokens.map((t) => t[2]))),
    output: sum(counted.flatMap((d) => d.tokens.map((t) => t[3]))),
    recorded: counted.length > 0,
    weekly: average(weeks),
    weekMax: weeks.length ? Math.max(...weeks) : null,
  };
}

/**
 * Every model of these months, the one with the most input first, so a model keeps its colour
 * from month to month and the main model gets the first.
 */
function modelOrder(loaded) {
  const input = new Map();
  for (const day of loaded.flatMap((data) => data.days)) {
    for (const [, model, tokens] of day?.tokens || []) {
      input.set(model, (input.get(model) || 0) + tokens);
    }
  }
  return [...input].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model);
}

/** `credentials` gives the project and the pod's token; `fetchFn` and the clock are swapped in tests. */
function createUsage({ credentials, fetchFn = fetch, now = () => new Date() }) {
  const cache = new Map();
  let list = { months: null, expires: 0 };
  let active = 0;
  const waiting = [];

  /** At most a few queries at a time, so a first load of many months stays gentle. */
  async function slot(run) {
    if (active >= PARALLEL) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  /** Series as [labels, [[time in ms, value], ...]], each point standing for the step before it. */
  async function range(query, start, end, step = HOUR) {
    const { project, token } = await credentials();
    const res = await slot(() =>
      fetchFn(`${MONITORING}/${project}/location/global/prometheus/api/v1/query_range`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: new URLSearchParams({
          query,
          start: String(start / 1000),
          end: String(end / 1000),
          step: String(step / 1000),
        }),
      }),
    );
    if (!res.ok) {
      throw new UsageError(502, `Cloud Monitoring HTTP ${res.status}`);
    }
    const body = await res.json();
    // No series at all comes back as null rather than [].
    return (body.data?.result || []).map(({ metric, values }) => [
      metric,
      values.map(([t, v]) => [t * 1000, Number(v)]),
    ]);
  }

  const lastHour = () => Math.floor(now().getTime() / HOUR) * HOUR;

  /** Months since the exporter's first day, newest first; the running month is always one. */
  async function months() {
    const at = now().getTime();
    if (at >= list.expires) {
      const end = lastHour();
      const entry = {
        months: range(highest(UP).replace('[1h]', '[1d]'), end - 730 * DAY, end, DAY).then(
          (series) => {
            const first = Math.min(...series.flatMap(([, points]) => points.map(([t]) => t)));
            const running = berlinDate.format(now()).slice(0, 7);
            if (!Number.isFinite(first)) {
              return [running];
            }
            const result = [];
            let [y, m] = hourDate(first).split('-').map(Number);
            for (let key = `${y}-${pad(m)}`; key <= running; key = `${y}-${pad(m)}`) {
              result.unshift(key);
              [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
            }
            return result;
          },
        ),
        expires: Infinity,
      };
      list = entry;
      entry.months.then(
        () => {
          entry.expires = now().getTime() + MONTHS_MS;
        },
        () => {
          if (list === entry) {
            list = { months: null, expires: 0 };
          }
        },
      );
    }
    return list.months;
  }

  async function load(y, m) {
    const key = `${y}-${pad(m)}`;
    const from = midnight(y, m, 1);
    const to = midnight(y, m + 1, 1);
    const end = Math.min(to, lastHour());
    const running = end < to;
    const days = Array(daysIn(y, m)).fill(null);
    const weeks = weeksOf(y, m).filter((w) => w.start < end);
    if (end > from) {
      const names = Object.keys(QUERIES);
      const [results, weekly] = await Promise.all([
        Promise.all(names.map((name) => range(QUERIES[name], from + HOUR, end))),
        weeks.length
          ? range(WEEKLY, weeks[0].start + HOUR, Math.min(weeks[weeks.length - 1].end, end))
          : [],
      ]);
      const series = Object.fromEntries(names.map((name, i) => [name, results[i]]));
      /** Each point of each series, with the day of the month its hour belongs to. */
      const perDay = (name, add) => {
        for (const [labels, points] of series[name]) {
          for (const [t, v] of points) {
            const date = hourDate(t);
            if (date.slice(0, 7) === key) {
              add(Number(date.slice(8)) - 1, v, labels);
            }
          }
        }
      };
      perDay('up', (i) => {
        days[i] ??= { conversations: 0, messages: 0, users: 0, tokens: null };
      });
      const add = (field) => (i, v) => {
        if (days[i]) {
          days[i][field] += v;
        }
      };
      perDay('conversations', add('conversations'));
      perDay('messages', add('messages'));
      perDay('users', (i, v) => {
        if (days[i]) {
          days[i].users = Math.max(days[i].users, v);
        }
      });
      const tokens = days.map(() => new Map());
      perDay('recorded', (i) => {
        if (days[i]) {
          days[i].tokens = [];
        }
      });
      const count = (purpose) => (i, v, labels) => {
        const name = `${purpose ?? labels.context}|${labels.model}`;
        const entry = tokens[i].get(name) || [purpose ?? labels.context, labels.model, 0, 0];
        entry[labels.type === 'output' ? 3 : 2] += v;
        tokens[i].set(name, entry);
      };
      perDay('chat', count('chat'));
      perDay('background', count(undefined));
      days.forEach((d, i) => {
        if (d?.tokens) {
          // Answers first, then the background requests by purpose and model.
          d.tokens = [...tokens[i].values()]
            .filter(([, , input, output]) => input || output)
            .sort(byPurpose);
        }
      });
      for (const w of weeks) {
        const points = weekly.flatMap(([, p]) => p).filter(([t]) => t > w.start && t <= w.end);
        w.users = points.length ? Math.max(...points.map(([, v]) => v)) : null;
        if (w.end > end) {
          w.running = true;
        }
      }
    }
    // A running month ends with the day of its last full hour.
    let last = daysIn(y, m);
    if (running) {
      last = end > from ? Number(hourDate(end).slice(8)) : 1;
    }
    const period = { from: isoDate(y, m, 1), to: isoDate(y, m, last), running };
    if (running) {
      period.through = new Date(end).toISOString();
    }
    return {
      month: key,
      period,
      days: days.map((d, i) => (i < last ? d : null)),
      weeks: weeks.map(({ start: _start, end: _end, ...w }) => w),
    };
  }

  /** Loads a month into the cache; requests while it loads share it, a reload keeps the old one. */
  function fetchMonth(y, m, key) {
    const entry = { data: load(y, m), value: null, expires: Infinity, refreshing: null };
    if (!cache.get(key)?.value) {
      cache.set(key, entry);
    }
    return entry.data.then(
      (data) => {
        const settled = now().getTime() >= midnight(y, m + 1, 1) + HOUR;
        entry.value = data;
        entry.expires = settled ? Infinity : now().getTime() + RUNNING_MS;
        cache.set(key, entry);
        return data;
      },
      (error) => {
        if (cache.get(key) === entry) {
          cache.delete(key);
        }
        throw error;
      },
    );
  }

  /**
   * A month, kept for good once it is over and its last hour has been counted. A running month
   * that is due again answers from memory while it reloads, so the page never waits for it.
   */
  async function month(y, m) {
    const key = `${y}-${pad(m)}`;
    const hit = cache.get(key);
    if (hit?.value && now().getTime() >= hit.expires) {
      hit.refreshing ??= fetchMonth(y, m, key)
        .catch(() => {})
        .finally(() => {
          hit.refreshing = null;
        });
      return hit.value;
    }
    return hit ? hit.data : fetchMonth(y, m, key);
  }

  /** Everything the tab shows for a month: its days, the month before, and every month's totals. */
  async function view(key) {
    const [y, m] = key.split('-').map(Number);
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    const previousKey = `${py}-${pad(pm)}`;
    const all = await months();
    const [current, loaded] = await Promise.all([
      month(y, m),
      Promise.all([...all].reverse().map((k) => month(...k.split('-').map(Number)))),
    ]);
    const trend = loaded.map((data) => ({
      month: data.month,
      running: data.period.running,
      firstDay: data.days.findIndex(Boolean) + 1 || null,
      ...totals(data),
    }));
    let previous = null;
    if (all.includes(previousKey)) {
      const before = await month(py, pm);
      const upTo = current.period.running
        ? Math.min(Number(current.period.to.slice(8)), daysIn(py, pm))
        : daysIn(py, pm);
      // From the first day with figures, such as the exporter's first day.
      const first = before.days.slice(0, upTo).findIndex(Boolean) + 1;
      if (first) {
        previous = {
          from: isoDate(py, pm, first),
          to: isoDate(py, pm, upTo),
          ...totals(before, upTo),
        };
      }
    }
    return {
      ...current,
      totals: totals(current),
      previous,
      months: all,
      trend,
      models: modelOrder(loaded),
    };
  }

  return { view, months };
}

module.exports = { createUsage, UsageError };
