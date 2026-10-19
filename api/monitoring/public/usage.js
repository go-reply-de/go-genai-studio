'use strict';
/* global MonitoringShell */

const { T, t, $, storage, monthLabel, berlinMonth } = MonitoringShell;
/** The server asks Cloud Monitoring again every two minutes, so asking it more often shows nothing new. */
const REFRESH_MS = 2 * 60 * 1000;
const SPLIT_KEY = 'monitoring-token-split';
/** Answers keep the strongest colour; the background requests follow. */
const PURPOSE_COLOURS = { chat: 's1', web_grounding: 's2', title: 's3' };
const COLOURS = ['s1', 's2', 's3', 's4', 's5'];

const num = (n) => Math.max(0, Number(n) || 0);
const int = (n) => Math.round(num(n)).toLocaleString(T.locale);
const compact = new Intl.NumberFormat(T.locale, { notation: 'compact', maximumFractionDigits: 1 });
/** Token counts run into millions; below ten thousand every digit still reads. */
const amount = (n) => (num(n) >= 10000 ? compact.format(num(n)) : int(n));
const percent = (v) =>
  new Intl.NumberFormat(T.locale, { style: 'percent', maximumFractionDigits: 0 }).format(v);
/** A share that rounds to nothing but is not nothing reads as under one per cent. */
const share = (part, whole) =>
  part > 0 && part / whole < 0.005 ? `< ${percent(0.01)}` : percent(part / whole);
/** A week's average of a few users keeps its decimal; larger ones read as whole people. */
const users = (n) =>
  num(n).toLocaleString(T.locale, { maximumFractionDigits: num(n) < 10 ? 1 : 0 });
const change = (now, before) => {
  if (!before) {
    return '';
  }
  const p = (now - before) / before;
  let sign = '±';
  if (p !== 0) {
    sign = p > 0 ? '+' : '−';
  }
  return `${sign}${percent(Math.abs(p))}`;
};
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const clock = (ms) =>
  new Date(ms).toLocaleTimeString(T.locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  });
const dayOf = (iso) => Number(iso.slice(8, 10));
const monthOf = (iso) => Number(iso.slice(5, 7));
const shortMonth = (month) => `${T.short[monthOf(month) - 1]} ${month.slice(0, 4)}`;

const remembered = storage((s) => s.getItem(SPLIT_KEY));
const state = {
  data: null,
  want: '',
  months: [],
  trend: [],
  failed: '',
  cache: new Map(),
  inflight: new Map(),
  timer: 0,
  hover: 0,
  split: ['purpose', 'model'].includes(remembered) ? remembered : $('content').dataset.defaultSplit,
};

function setLive(kind, text) {
  $('live').hidden = !text;
  $('live').className = `live ${kind}`;
  $('live-text').textContent = text;
}

/** A running month says when it was fetched; a finished month needs no status. */
function settleLive(data) {
  const at = state.cache.get(data.month)?.at || Date.now();
  setLive('on', data.period.running ? t('live', { time: clock(at) }) : '');
}

function busy(on) {
  // Placeholders stand in on the first load; after that the previous month fades back.
  $('content').classList.toggle('stale', on && Boolean(state.data));
  if (on) {
    $('content').setAttribute('aria-busy', 'true');
    setLive('busy', t('loading'));
  } else {
    $('content').removeAttribute('aria-busy');
  }
}

function showError(message) {
  $('error').hidden = !message;
  $('error-text').textContent = message || '';
}

/** One request per month at a time; every answer is kept for switching back. */
function request(month) {
  if (!state.inflight.has(month)) {
    const pending = fetch(`api/usage?m=${encodeURIComponent(month)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(res.status === 403 ? 'forbidden' : `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        state.cache.set(month, { data, at: Date.now() });
        return data;
      })
      .finally(() => state.inflight.delete(month));
    state.inflight.set(month, pending);
  }
  return state.inflight.get(month);
}

/** Shows a month: at once from memory, otherwise once it has loaded. The latest choice wins. */
async function show(month) {
  state.want = month;
  state.failed = '';
  clearTimeout(state.timer);
  picker.renderNav(month);
  const hit = state.cache.get(month);
  if (hit) {
    apply(hit.data);
    settleLive(hit.data);
    if (Date.now() - hit.at < REFRESH_MS) {
      settle(hit.data);
      return;
    }
  } else {
    busy(true);
  }
  try {
    const data = await request(month);
    if (state.want !== month) {
      return;
    }
    if (!data.months.includes(month)) {
      // An old link to a month without data: show the newest month instead.
      history.replaceState(null, '', location.pathname);
      show(data.months[0]);
      return;
    }
    apply(data);
    settle(data);
  } catch (error) {
    if (state.want !== month) {
      return;
    }
    busy(false);
    if (hit) {
      setLive('warn', t('stale'));
      schedule();
      return;
    }
    state.failed = month;
    showError(
      error.message === 'forbidden'
        ? t('usageNoAccess')
        : t('loadFailed', { month: monthLabel(month) }),
    );
    if (state.data) {
      state.want = state.data.month;
      history.replaceState(null, '', `?m=${state.data.month}`);
      picker.renderNav(state.data.month);
      settleLive(state.data);
      schedule();
    } else {
      setLive('warn', t('notLoaded'));
    }
  }
}

function settle(data) {
  busy(false);
  showError('');
  settleLive(data);
  prefetchAround(data.month);
  schedule();
}

function navigate(month) {
  if (!month || month === state.want) {
    return;
  }
  history.replaceState(null, '', `?m=${month}`);
  state.hover = 0;
  show(month);
}

/** Loads the months next to this one in the background, so stepping is instant. */
function prefetchAround(month) {
  const i = state.months.indexOf(month);
  for (const next of i < 0 ? [] : [state.months[i + 1], state.months[i - 1]]) {
    if (next && !state.cache.has(next)) {
      request(next).catch(() => {});
    }
  }
}

/** Fetches the running month again. */
async function poll() {
  const month = state.data?.month;
  if (!month || state.want !== month) {
    return;
  }
  state.cache.delete(month);
  try {
    const data = await request(month);
    if (state.want === month) {
      apply(data);
      settleLive(data);
    }
  } catch {
    if (state.want === month) {
      setLive('warn', t('pollFailed', { time: clock(Date.now() + REFRESH_MS) }));
    }
  } finally {
    if (state.want === month) {
      schedule();
    }
  }
}

function schedule() {
  clearTimeout(state.timer);
  if (!state.data?.period.running) {
    return;
  }
  state.timer = setTimeout(() => {
    if (document.hidden) {
      schedule();
    } else {
      poll();
    }
  }, REFRESH_MS);
}

function apply(data) {
  state.data = data;
  state.months = data.months;
  state.trend = data.trend;
  picker.refresh();
  picker.renderNav(data.month);
  document.title = `${monthLabel(data.month)} · ${$('app').textContent} ${t('usageTab')}`;
  renderPeriod();
  renderStats();
  renderUsageTable();
  renderSplit();
  renderTrends();
  renderCharts();
}

function renderPeriod() {
  const d = state.data;
  const p = d.previous;
  const m = Number(d.month.slice(5));
  const before = T.months[(m + 10) % 12];
  let scope = t('usageScopeNone', { month: before });
  if (p && dayOf(p.from) > 1) {
    // The month before has figures only from a later day, such as the exporter's first day.
    scope = t('usageScopeSpan', { span: T.daySpan(dayOf(p.from), dayOf(p.to)), month: before });
  } else if (p) {
    scope = d.period.running
      ? t('scopeSame', { span: T.span(dayOf(p.to)), month: before })
      : t('scopeWhole', { month: before });
  }
  $('period').textContent = d.period.running
    ? t('usageRunning', {
        date: T.longDate(dayOf(d.period.to), m),
        time: clock(Date.parse(d.period.through)),
        scope,
      })
    : t('periodClosed', { scope });
}

/** The web search tool's input tokens of the month. */
const webTokens = (days) =>
  days
    .filter((day) => day?.tokens)
    .flatMap((day) => day.tokens)
    .filter(([purpose]) => purpose === 'web_grounding')
    .reduce((sum, entry) => sum + entry[2], 0);

function renderStats() {
  const { totals: c, previous: p } = state.data;
  const vs = (now, before, format) =>
    p
      ? [t('previous', { value: format(before) }), change(now, before)].filter(Boolean).join(' · ')
      : '';
  $('k-conversations').textContent = int(c.conversations);
  $('p-conversations').textContent = vs(c.conversations, p?.conversations, int);
  $('k-messages').textContent = int(c.messages);
  $('p-messages').textContent = vs(c.messages, p?.messages, int);
  $('k-weekly').textContent = c.weekly === null ? '–' : users(c.weekly);
  $('p-weekly').textContent = [
    c.weekMax === null ? '' : t('busiestWeek', { n: int(c.weekMax) }),
    p?.weekly == null ? '' : t('previous', { value: users(p.weekly) }),
  ]
    .filter(Boolean)
    .join(' · ');
  for (const field of ['input', 'output']) {
    $(`k-${field}`).textContent = c.recorded ? amount(c[field]) : '–';
    let cmp = c.recorded ? '' : t('notRecorded');
    if (c.recorded && p) {
      cmp = p.recorded
        ? vs(c[field], p[field], amount)
        : t('previous', { value: t('notRecorded') });
    }
    $(`p-${field}`).textContent = cmp;
  }
  const web = webTokens(state.data.days);
  $('k-web').textContent = c.recorded ? amount(web) : '–';
  let webNote = t('notRecorded');
  if (c.recorded) {
    webNote = c.input ? t('shareOfInput', { share: share(web, c.input) }) : '';
  }
  $('p-web').textContent = webNote;
}

/** The top of an axis: twice a 1, 2 or 5 step, so the middle gridline is a whole number too. */
function niceMax(max) {
  const half = Math.max(1, max / 2);
  const step = 10 ** Math.floor(Math.log10(half));
  const mult = [1, 2, 5, 10].find((m) => m * step >= half);
  return 2 * mult * step;
}

const millions = (v, digits) =>
  t('millions', {
    n: (v / 1e6).toLocaleString(T.locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits || 2,
    }),
  });
/** Numbers along one axis or list in one unit: millions once its largest value reaches a million. */
const inUnitOf = (v, largest) => (largest >= 1e6 && v ? millions(v, 0) : int(v));
/** A day's input and output read in one unit, the larger one's. */
const tokenPair = (input, output) =>
  Math.max(input, output) >= 1e6
    ? [millions(input, 2), millions(output, 2)]
    : [int(input), int(output)];

const inputOf = (day, key, g) =>
  day.tokens.filter((e) => key(e) === g.key).reduce((sum, e) => sum + e[2], 0);

/** The Nutzung lane's day chart: conversations as bars, users per day as a line. */
function usageChart() {
  const d = state.data;
  const any = d.days.some((day) => day && (day.conversations || day.messages));
  return {
    stacks: d.days.map((day) => (day ? [{ cls: 'neutral', v: day.conversations }] : null)),
    line: (day) => day.users,
    empty: any ? '' : t('noUsageYet'),
  };
}

/** The Tokens lane's day chart: input per day, stacked by purpose or by model. */
function tokensChart() {
  const d = state.data;
  const { key, list } = groups(state.split);
  let empty = '';
  if (!d.totals.recorded) {
    empty = t('tokensNotRecorded');
  } else if (!list.length) {
    empty = t('noTokensYet');
  }
  return {
    stacks: d.days.map((day) =>
      day?.tokens ? list.map((g) => ({ cls: g.cls, v: inputOf(day, key, g) })) : null,
    ),
    empty,
  };
}

function topOf({ stacks, line }) {
  return niceMax(
    Math.max(
      0,
      ...stacks.filter(Boolean).map((parts) => parts.reduce((sum, p) => sum + num(p.v), 0)),
      ...(line ? state.data.days.filter(Boolean).map(line) : []),
    ),
  );
}

/**
 * Bars per day for the whole month, with an optional line on the same scale; in a running month
 * a thin line marks today and the days after stay empty. Drawn at the box's own size in pixels,
 * like the Feedback tab's chart. Each day is a group the other lane's chart follows.
 */
function drawDays(svg, box, { stacks, line, empty, top, left }) {
  const d = state.data;
  const rect = box.getBoundingClientRect();
  const [w, h] = [Math.round(rect.width) || 600, Math.round(rect.height) || 200];
  const days = d.days;
  const last = d.period.running ? dayOf(d.period.to) : days.length;
  const any = stacks.some((parts) => parts?.some((p) => num(p.v) > 0));
  const [right, y0, y1] = [w - 4, h - 30, 10];
  const step = (right - left) / days.length;
  const width = Math.max(2, step * 0.72);
  const radius = Math.min(3, width / 2);
  const y = (v) => y0 - (num(v) / top) * (y0 - y1);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  // Without data only the baseline stays, so the message stands on clear ground.
  let out = (empty ? [0] : [0, top / 2, top])
    .map(
      (v) =>
        `<line class="grid" x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/>` +
        (any
          ? `<text x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${inUnitOf(v, top)}</text>`
          : ''),
    )
    .join('');
  const marker = last < days.length ? left + last * step : null;
  const tagWidth = t('today').length * 7 + 16;
  if (marker !== null) {
    out += `<line class="today-line" x1="${marker}" x2="${marker}" y1="${y1}" y2="${y0 + 8}"/>`;
    out += `<rect class="today-tag" x="${marker - tagWidth / 2}" y="${y0 + 8}" width="${tagWidth}" height="20" rx="10"/>`;
    out += `<text class="today-label" x="${marker}" y="${y0 + 22}" text-anchor="middle">${t('today')}</text>`;
  }
  days.forEach((day, i) => {
    const center = left + (i + 0.5) * step;
    if (stacks[i]) {
      let base = y0;
      let parts = '';
      for (const p of stacks[i]) {
        const height = y0 - y(p.v);
        if (height > 0) {
          parts += `<rect class="${p.cls}" x="${center - width / 2}" y="${base - height}" width="${width}" height="${height}" rx="${radius}"/>`;
          base -= height + (height > 2 ? 1 : 0);
        }
      }
      out += `<g data-day="${i + 1}"><rect class="hit" x="${left + i * step}" y="${y1}" width="${step}" height="${y0 - y1}"/>${parts}</g>`;
    }
    const clear = marker === null || Math.abs(center - marker) > tagWidth / 2 + 14;
    if ((i === 0 || (i + 1) % 5 === 0) && clear) {
      out += `<text x="${center}" y="${y0 + 22}" text-anchor="middle">${T.axisDay(i + 1)}</text>`;
    }
  });
  if (line) {
    const points = days
      .map((day, i) => (day ? `${left + (i + 0.5) * step},${y(line(day))}` : null))
      .filter(Boolean);
    if (points.length > 1) {
      out += `<polyline class="line" points="${points.join(' ')}"/>`;
    }
  }
  if (empty) {
    out += `<text class="empty" x="${(left + right) / 2}" y="${(y0 + y1) / 2}" text-anchor="middle">${esc(empty)}</text>`;
  }
  svg.innerHTML = out;
}

/**
 * Room for the widest number either axis can show, such as "0,75 Mio.", whatever the month:
 * the days stay in place when the month changes, and line up in both lanes.
 */
const GUTTER =
  Math.max(...[int(750000), millions(750000, 0), millions(25e6, 0)].map((s) => s.length)) * 7 + 14;

/** Both day charts on one left edge, so the same day stands at the same place in both lanes. */
function renderCharts() {
  const charts = [
    [$('usage-chart'), $('usage-box'), usageChart()],
    [$('tokens-chart'), $('tokens-box'), tokensChart()],
  ].map(([svg, box, chart]) => ({ svg, box, chart, top: topOf(chart) }));
  for (const { svg, box, chart, top } of charts) {
    drawDays(svg, box, { ...chart, top, left: GUTTER });
  }
  hover(state.hover);
}

function renderUsageTable() {
  const d = state.data;
  const month = monthOf(d.period.from);
  $('usage-table').innerHTML =
    `<caption>${t('perDayUsage')}</caption>` +
    `<tr><th>${t('day')}</th><th>${t('legendConversations')}</th><th>${t('messages')}</th><th>${t('legendUsers')}</th></tr>` +
    d.days
      .map((day, i) =>
        day
          ? `<tr><td>${T.shortDate(i + 1, month)}</td><td>${int(day.conversations)}</td><td>${int(day.messages)}</td><td>${int(day.users)}</td></tr>`
          : '',
      )
      .join('');
}

/**
 * The month's tokens grouped by purpose or by model, biggest input first. Colours follow the
 * purpose, or the server's order of every month's models, so they stay the same between months.
 */
function groups(split) {
  const key = split === 'purpose' ? (e) => e[0] : (e) => e[1];
  const totals = new Map();
  for (const day of state.data.days) {
    for (const entry of day?.tokens || []) {
      const g = totals.get(key(entry)) || { key: key(entry), input: 0, output: 0 };
      g.input += entry[2];
      g.output += entry[3];
      totals.set(g.key, g);
    }
  }
  const list = [...totals.values()].sort((a, b) => b.input - a.input || b.output - a.output);
  const names = list.map((g) => g.key).sort();
  const known = state.data.models || [];
  const rank = (name) =>
    known.includes(name) ? known.indexOf(name) : known.length + names.indexOf(name);
  for (const g of list) {
    if (split === 'purpose') {
      const others = names.filter((name) => !(name in PURPOSE_COLOURS));
      g.label = T.purposes[g.key] || t('otherPurpose', { name: g.key });
      g.short = T.purposesShort[g.key] || g.key;
      g.cls =
        PURPOSE_COLOURS[g.key] || COLOURS[Math.min(3 + others.indexOf(g.key), COLOURS.length - 1)];
    } else {
      g.label = g.key;
      g.short = g.key;
      g.cls = COLOURS[Math.min(rank(g.key), COLOURS.length - 1)];
    }
  }
  return { key, list };
}

function renderSplit() {
  const d = state.data;
  const purpose = state.split === 'purpose';
  document.querySelectorAll('[data-split]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.split === state.split));
  });
  const { key, list } = groups(state.split);
  $('tokens-chart-title').textContent = purpose ? t('tokensByPurpose') : t('tokensByModel');
  $('tokens-legend').innerHTML = list
    .map((g) => `<span><i class="dot ${g.cls}"></i>${esc(g.short)}</span>`)
    .join('');
  const month = monthOf(d.period.from);
  $('tokens-table').innerHTML =
    `<caption>${t('tokensDay')}</caption>` +
    `<tr><th>${t('day')}</th>${list.map((g) => `<th>${esc(g.label)}</th>`).join('')}</tr>` +
    d.days
      .map((day, i) =>
        day?.tokens
          ? `<tr><td>${T.shortDate(i + 1, month)}</td>${list.map((g) => `<td>${int(inputOf(day, key, g))}</td>`).join('')}</tr>`
          : '',
      )
      .join('');
  $('split-title').textContent = purpose ? t('tableByPurpose') : t('tableByModel');
  $('split-col').textContent = purpose ? t('splitPurpose') : t('splitModel');
  const total = list.reduce((sum, g) => sum + g.input, 0);
  // Every digit, since these figures are copied into the report.
  $('split-rows').closest('table').tHead.hidden = !list.length;
  $('split-rows').innerHTML = list.length
    ? list
        .map(
          (g) =>
            `<tr><td><i class="dot ${g.cls}" aria-hidden="true"></i>${esc(g.label)}</td>` +
            `<td>${int(g.input)}</td><td>${int(g.output)}</td>` +
            `<td>${total ? share(g.input, total) : '–'}</td></tr>`,
        )
        .join('')
    : `<tr><td class="empty" colspan="4">${d.totals.recorded ? t('noTokensYet') : t('tokensNotRecorded')}</td></tr>`;
  const foot = purpose ? t('purposeFoot') : t('modelFoot');
  $('split-foot').textContent = list.length ? foot : '';
}

function renderTrends() {
  const newest = [...state.trend].reverse();
  const label = (m) => {
    if (m.running) {
      return t('monthRunning', { month: shortMonth(m.month) });
    }
    if (m.firstDay > 1) {
      return t('monthFrom', { month: shortMonth(m.month), day: T.axisDay(m.firstDay) });
    }
    return shortMonth(m.month);
  };
  const row = (m, value, max, format) =>
    `<li><button type="button" data-month="${m.month}"${m.month === state.data.month ? ' aria-current="true"' : ''}>` +
    `<span class="m">${esc(label(m))}</span>` +
    `<span class="track" aria-hidden="true"><i style="width:${max ? Math.round((100 * value) / max) : 0}%"></i></span>` +
    `<span class="v">${format(value)}</span></button></li>`;
  const most = Math.max(0, ...newest.map((m) => m.conversations));
  $('usage-trend').innerHTML = newest.map((m) => row(m, m.conversations, most, int)).join('');
  const mostTokens = Math.max(0, ...newest.filter((m) => m.recorded).map((m) => m.input));
  $('tokens-trend').innerHTML = newest
    .map((m) =>
      m.recorded
        ? row(m, m.input, mostTokens, (v) => (mostTokens >= 1e6 ? millions(v, 1) : int(v)))
        : `<li class="none"><span class="m">${esc(label(m))}</span><span class="note">${t('noTokenMonth')}</span></li>`,
    )
    .join('');
}

/** One day lifted in both lanes, its figures written under each chart; 0 shows the whole month. */
function hover(day) {
  state.hover = day;
  const data = state.data;
  const entry = day ? data?.days[day - 1] : null;
  $('lanes').classList.toggle('linked', Boolean(entry));
  document.querySelectorAll('#lanes [data-day]').forEach((g) => {
    g.classList.toggle('hl', Number(g.dataset.day) === day);
  });
  if (!entry) {
    $('usage-day').textContent = t('hoverHint');
    $('tokens-day').textContent = '';
    return;
  }
  const date = T.shortDate(day, monthOf(data.period.from));
  $('usage-day').textContent = t('dayUsage', {
    date,
    conversations: int(entry.conversations),
    messages: int(entry.messages),
    users: int(entry.users),
  });
  if (!entry.tokens) {
    $('tokens-day').textContent = t('dayNoTokens', { date });
    return;
  }
  const [input, output] = tokenPair(
    entry.tokens.reduce((sum, e) => sum + e[2], 0),
    entry.tokens.reduce((sum, e) => sum + e[3], 0),
  );
  $('tokens-day').textContent = t('dayTokens', { date, input, output });
}

const picker = MonitoringShell.monthPicker({
  months: () => state.months,
  current: () => state.want,
  describe: (month) => {
    const n = state.trend.find((m) => m.month === month)?.conversations ?? 0;
    return {
      count: int(n),
      detail: n === 1 ? t('conversationsOne') : t('conversationsMany', { n: int(n) }),
    };
  },
  none: t('noUsage'),
  earlier: t('noUsageEarlier'),
  later: t('noUsageLater'),
  onPick: navigate,
});

// A mouse lifts the day under it; a tap pins a day until the next tap, and so do the arrow keys.
$('lanes').addEventListener('pointerover', (event) => {
  const g = event.target.closest('[data-day]');
  if (g && event.pointerType === 'mouse') {
    hover(Number(g.dataset.day));
  }
});
for (const box of document.querySelectorAll('.day-box')) {
  box.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') {
      hover(0);
    }
  });
}
document.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' || !state.data) {
    return;
  }
  const g = event.target.closest('#lanes [data-day]');
  const day = g ? Number(g.dataset.day) : 0;
  hover(day === state.hover ? 0 : day);
});
$('lanes').addEventListener('keydown', (event) => {
  if (!event.target.classList.contains('day-box') || !state.data) {
    return;
  }
  const days = state.data.days.flatMap((d, i) => (d ? [i + 1] : []));
  const i = days.indexOf(state.hover);
  const moves = {
    ArrowRight: i < 0 ? 0 : Math.min(i + 1, days.length - 1),
    ArrowLeft: i < 0 ? days.length - 1 : Math.max(i - 1, 0),
    Home: 0,
    End: days.length - 1,
  };
  if (event.key === 'Escape' && state.hover) {
    event.preventDefault();
    hover(0);
  } else if (event.key in moves && days.length) {
    event.preventDefault();
    hover(days[moves[event.key]]);
  }
});
$('lanes').addEventListener('focusout', (event) => {
  const leaving = event.target.classList.contains('day-box');
  if (leaving && !event.relatedTarget?.classList?.contains('day-box')) {
    hover(0);
  }
});
$('lanes').addEventListener('click', (event) => {
  const split = event.target.closest('[data-split]');
  if (split && state.data) {
    state.split = split.dataset.split;
    storage((s) => s.setItem(SPLIT_KEY, state.split));
    renderSplit();
    renderCharts();
  }
  const month = event.target.closest('.trend button');
  if (month) {
    navigate(month.dataset.month);
  }
});
$('retry').addEventListener('click', () => {
  const month = state.failed || state.want;
  history.replaceState(null, '', `?m=${month}`);
  show(month);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && picker.isOpen()) {
    event.preventDefault();
    picker.close(true);
  }
});
document.addEventListener('visibilitychange', () => {
  const at = state.data ? state.cache.get(state.data.month)?.at : 0;
  if (!document.hidden && state.data?.period.running && Date.now() - (at || 0) >= REFRESH_MS) {
    poll();
  }
});

// The charts are drawn at their boxes' size, so they follow the boxes.
new ResizeObserver(() => {
  if (state.data) {
    renderCharts();
  }
}).observe($('lanes'));

document.querySelectorAll('[data-split]').forEach((b) => {
  b.setAttribute('aria-pressed', String(b.dataset.split === state.split));
});

// The server writes the month into the page; the clock is only a fallback.
const initial = $('month-button').dataset.month || berlinMonth();
state.months = [initial];
show(initial);
