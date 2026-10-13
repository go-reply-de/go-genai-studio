'use strict';

const REASONS = {
  inaccurate: 'Ungenaue oder falsche Antwort',
  not_helpful: 'Es fehlten nützliche Informationen',
  not_matched: 'Entspricht nicht der Anfrage',
  unjustified_refusal: 'Mit anderer Begründung abgelehnt',
  bad_style: 'Schlechter Stil oder Tonfall',
  missing_image: 'Bild erwartet',
  other: 'Anderer Fehler',
  accurate_reliable: 'Akkurat und Zuverlässig',
  creative_solution: 'Kreative Lösung',
  clear_well_written: 'Klar und gut geschrieben',
  attention_to_detail: 'Liebe zum Detail',
  unknown: 'Unbekannt',
};
const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
const SHORT = [
  'Jan.',
  'Feb.',
  'März',
  'Apr.',
  'Mai',
  'Juni',
  'Juli',
  'Aug.',
  'Sep.',
  'Okt.',
  'Nov.',
  'Dez.',
];
const REFRESH_MS = 60000;
/** A month shown from memory is checked again in the background once it is this old. */
const FRESH_MS = 60000;
const PAGE = 50;
const MARKER = '[entfernt]';
const SEEN_KEY = 'feedback-seen';
const SEEN_MAX = 5000;
const THEME_KEY = 'feedback-theme';
const TODAY_NOTE = 'Heute eingegangen: Änderungen sind oft erst nach etwa 90 Minuten möglich.';

/**
 * Likely personal data, found only in this browser. The API already masks e-mail addresses,
 * full dates and long numbers when it saves a text; what is left are names and partial dates.
 */
const HINTS = [
  /\b(?:Herr|Frau|Hr\.|Fr\.|Dr\.|Prof\.|Pat\.|Patientin|Patient|Kollegin|Kollege|Schwester|Pflegerin|Pfleger)\s+[A-ZÄÖÜ][\p{L}-]+/gu,
  /\[(?:Nummer|Datum|E-Mail)\]/g,
  /\b\d{1,2}\.\s?\d{1,2}\.(?:\s?\d{2,4})?(?!\d)/g,
  /\b(?:geb\.|geboren|Geburtsdatum|Fallnummer|Fall-Nr\.?|Aufnahmenummer|Station\s+\d+\w*|Zimmer\s+\d+)/giu,
  /\b(?!(?:19|20)\d{2}\b)\d{4,5}\b/g,
];

const ICON = {
  thumbsUp:
    '<svg class="i up" viewBox="0 0 24 24" role="img" aria-label="Daumen hoch"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>',
  thumbsDown:
    '<svg class="i down" viewBox="0 0 24 24" role="img" aria-label="Daumen runter"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>',
  clean:
    '<svg class="i small" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>',
  trash:
    '<svg class="i small" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
};

const $ = (id) => document.getElementById(id);
const num = (n) => Math.max(0, Number(n) || 0);
const int = (n) => num(n).toLocaleString('de-DE');
const share = (part, whole) =>
  whole >= 10 ? `${((100 * num(part)) / whole).toFixed(1).replace('.', ',')} %` : null;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
const dayOf = (iso) => Number(iso.slice(8, 10));
const monthOf = (iso) => Number(iso.slice(5, 7));
const days = (to) => (dayOf(to) === 1 ? '1.' : `1.–${dayOf(to)}.`);
const clock = (ms) =>
  new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const monthLabel = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const berlinMonth = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());

function storage(read) {
  try {
    return read(localStorage);
  } catch {
    return null;
  }
}

// Texts seen in an earlier visit; anything else is marked "Neu". A first visit marks nothing.
const seenStored = storage((s) => s.getItem(SEEN_KEY));
const seen = new Set(storage(() => JSON.parse(seenStored || '[]')) || []);
let firstVisit = seenStored === null;

const state = {
  data: null,
  rows: [],
  rating: '',
  hintsOnly: false,
  shown: PAGE,
  open: null,
  drafts: new Map(),
  arrived: new Set(),
  months: [],
  ratings: {},
  year: 0,
  want: '',
  failed: '',
  cache: new Map(),
  inflight: new Map(),
  timer: 0,
};

function rememberSeen(ids) {
  const stored = storage((s) => JSON.parse(s.getItem(SEEN_KEY) || '[]')) || [];
  const all = [...new Set([...stored, ...ids])];
  storage((s) => s.setItem(SEEN_KEY, JSON.stringify(all.slice(-SEEN_MAX))));
}

function findHints(text) {
  const ranges = [];
  for (const pattern of HINTS) {
    for (const match of text.matchAll(pattern)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

const WRAP = {
  match: (part) => `<mark class="match">${part}</mark>`,
  hint: (part) => `<mark class="hint" title="Mögliche Personenangabe">${part}</mark>`,
  removed: (part) => `<span class="removed">${part}</span>`,
};

/** The text with search matches, likely personal data and removed parts marked, escaped. */
function highlight(text, query, hints) {
  const kinds = new Array(text.length).fill('');
  for (const [start, end] of hints) {
    kinds.fill('hint', start, end);
  }
  for (let i = text.indexOf(MARKER); i >= 0; i = text.indexOf(MARKER, i + 1)) {
    kinds.fill('removed', i, i + MARKER.length);
  }
  if (query) {
    const lower = text.toLowerCase();
    for (let i = lower.indexOf(query); i >= 0; i = lower.indexOf(query, i + 1)) {
      kinds.fill('match', i, i + query.length);
    }
  }
  let html = '';
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && kinds[i] === kinds[start]) {
      continue;
    }
    const part = esc(text.slice(start, i));
    html += WRAP[kinds[start]]?.(part) ?? part;
    start = i;
  }
  return html;
}

function enrich(text, data) {
  return {
    ...text,
    hints: findHints(text.text),
    cleaned: text.text.includes(MARKER),
    isNew: !seen.has(text.id),
    today: data.period.running && text.date === data.period.to,
  };
}

function setLive(kind, text) {
  $('live').hidden = !text;
  $('live').className = `live ${kind}`;
  $('live-text').textContent = text;
}

/** A running month says when it was fetched; a finished month needs no status. */
function settleLive(data) {
  const at = state.cache.get(data.month)?.at || Date.now();
  setLive('on', data.period.running ? `Live · aktualisiert ${clock(at)}` : '');
}

function busy(on) {
  // Placeholders stand in on the first load; after that the previous month fades back.
  $('content').classList.toggle('stale', on && Boolean(state.data));
  if (on) {
    $('content').setAttribute('aria-busy', 'true');
    setLive('busy', 'Lädt …');
  } else {
    $('content').removeAttribute('aria-busy');
  }
}

function showError(message) {
  $('error').hidden = !message;
  $('error-text').textContent = message || '';
}

let toastTimer = 0;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 4000);
}

/** One request per month at a time; every answer is kept for switching back. */
function request(month) {
  if (!state.inflight.has(month)) {
    const pending = fetch(`api/month?m=${encodeURIComponent(month)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(res.status === 403 ? 'Kein Zugriff.' : `HTTP ${res.status}`);
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
  renderNav(month);
  const hit = state.cache.get(month);
  if (hit) {
    apply(hit.data, false);
    settleLive(hit.data);
    if (Date.now() - hit.at < FRESH_MS) {
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
      // An old link to a month without feedback: show the newest month instead.
      history.replaceState(null, '', location.pathname);
      show(data.months[0]);
      return;
    }
    apply(data, false);
    settle(data);
  } catch (error) {
    if (state.want !== month) {
      return;
    }
    busy(false);
    if (hit) {
      setLive('warn', 'Nicht aktuell · Aktualisierung fehlgeschlagen');
      schedule();
      return;
    }
    state.failed = month;
    showError(
      error.message === 'Kein Zugriff.'
        ? 'Kein Zugriff auf die Feedback-Daten.'
        : `${monthLabel(month)} konnte nicht geladen werden.`,
    );
    if (state.data) {
      state.want = state.data.month;
      history.replaceState(null, '', `?m=${state.data.month}`);
      renderNav(state.data.month);
      settleLive(state.data);
      schedule();
    } else {
      setLive('warn', 'Nicht geladen');
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
  closeWork(false);
  state.shown = PAGE;
  history.replaceState(null, '', `?m=${month}`);
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

/** Fetches the running month again; new texts slide in. */
async function poll() {
  const month = state.data?.month;
  if (!month || state.want !== month) {
    return;
  }
  try {
    const data = await request(month);
    if (state.want === month) {
      apply(data, true);
      settleLive(data);
    }
  } catch {
    if (state.want === month) {
      setLive(
        'warn',
        `Aktualisierung fehlgeschlagen · nächster Versuch ${clock(Date.now() + REFRESH_MS)}`,
      );
    }
  } finally {
    if (state.want === month) {
      schedule();
    }
  }
}

function apply(data, live) {
  const known = new Set(state.rows.map((r) => r.id));
  if (live) {
    data.texts.filter((t) => !known.has(t.id)).forEach((t) => state.arrived.add(t.id));
  }
  if (firstVisit) {
    data.texts.forEach((t) => seen.add(t.id));
    firstVisit = false;
  }
  state.data = data;
  state.rows = data.texts.map((t) => enrich(t, data));
  renderMonths(data.months, data.ratingsByMonth);
  renderNav(data.month);
  if (state.open && !state.rows.some((r) => r.id === state.open.id)) {
    state.open = null;
    toast('Der Freitext, den Sie gerade bearbeitet haben, wurde inzwischen gelöscht.');
  }
  renderHeader();
  renderStats();
  renderChart();
  renderReasons();
  renderTexts();
  rememberSeen(data.texts.map((t) => t.id));
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

/** The months with feedback and their ratings; an open grid shows them at once. */
function renderMonths(months, ratings = {}) {
  state.months = months;
  state.ratings = ratings;
  if (!$('month-pop').hidden) {
    renderGrid();
  }
}

/** A loaded month knows its ratings best; for the running month that is the latest poll. */
const ratingsOf = (month) =>
  state.cache.get(month)?.data.current.rated ?? state.ratings[month] ?? 0;

/** One year as a grid; only months with feedback can be opened. */
function renderGrid() {
  const focused = document.activeElement?.closest?.('#month-grid button')?.dataset.month;
  const newest = state.months[0] || state.want;
  const years = state.months.map((month) => Number(month.slice(0, 4)));
  $('year-label').textContent = state.year;
  $('year-prev').disabled = state.year <= Math.min(...years);
  $('year-next').disabled = state.year >= Math.max(...years);
  const cells = MONTHS.map((name, i) => {
    const month = `${state.year}-${String(i + 1).padStart(2, '0')}`;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.tabIndex = -1;
    cell.dataset.month = month;
    cell.disabled = !state.months.includes(month);
    let count = month > newest ? '' : '–';
    let detail = month > newest ? 'noch nicht begonnen' : 'kein Feedback';
    if (!cell.disabled) {
      count = int(ratingsOf(month));
      detail = `${count} Bewertungen${month === newest ? ', läuft' : ''}`;
    }
    cell.innerHTML = `<span>${SHORT[i]}</span><small>${count}</small>`;
    cell.setAttribute('aria-label', `${name} ${state.year}, ${detail}`);
    cell.classList.toggle('running', month === newest);
    if (month === state.want) {
      cell.setAttribute('aria-current', 'true');
    }
    return cell;
  });
  $('month-grid').replaceChildren(...cells);
  const target =
    cells.find((c) => c.dataset.month === focused && !c.disabled) ||
    cells.find((c) => c.hasAttribute('aria-current')) ||
    cells.find((c) => !c.disabled);
  if (target) {
    target.tabIndex = 0;
    if (focused) {
      target.focus();
    }
  }
}

function openPicker() {
  state.year = Number(state.want.slice(0, 4));
  $('month-pop').hidden = false;
  $('month-button').setAttribute('aria-expanded', 'true');
  renderGrid();
  $('month-grid').querySelector('[tabindex="0"]')?.focus();
}

function closePicker(restoreFocus) {
  if ($('month-pop').hidden) {
    return;
  }
  $('month-pop').hidden = true;
  $('month-button').setAttribute('aria-expanded', 'false');
  if (restoreFocus) {
    $('month-button').focus();
  }
}

function changeYear(step) {
  state.year += step;
  renderGrid();
  // A year button that has just been disabled drops focus; keep it inside the picker.
  if (document.activeElement === document.body || document.activeElement?.disabled) {
    $('month-grid').querySelector('[tabindex="0"]')?.focus();
  }
}

const GRID_KEYS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };

/** Arrow keys move between months with feedback, Home and End jump to the first and last. */
function moveInGrid(event) {
  const cells = [...$('month-grid').children];
  const open = cells.filter((c) => !c.disabled);
  let to;
  if (event.key in GRID_KEYS) {
    const step = GRID_KEYS[event.key];
    let i = cells.indexOf(document.activeElement) + step;
    while (i >= 0 && i < cells.length && cells[i].disabled) {
      i += step;
    }
    to = cells[i];
  } else if (event.key === 'Home' || event.key === 'End') {
    to = event.key === 'Home' ? open[0] : open[open.length - 1];
  } else {
    return;
  }
  event.preventDefault();
  if (to) {
    cells.forEach((c) => {
      c.tabIndex = -1;
    });
    to.tabIndex = 0;
    to.focus();
  }
}

function setStep(button, month, label, none) {
  button.disabled = !month;
  button.dataset.month = month || '';
  button.setAttribute('aria-label', month ? `${label}: ${monthLabel(month)}` : none);
  button.title = month ? monthLabel(month) : none;
}

function renderNav(month) {
  $('month-button').dataset.month = month;
  $('month-title').textContent = monthLabel(month);
  const i = state.months.indexOf(month);
  setStep(
    $('prev'),
    i < 0 ? '' : state.months[i + 1],
    'Vorheriger Monat',
    'Kein früherer Monat mit Feedback',
  );
  setStep(
    $('next'),
    i > 0 ? state.months[i - 1] : '',
    'Nächster Monat',
    'Kein späterer Monat mit Feedback',
  );
}

/** The brand and the reviewer are written into the page by the server; only the month changes. */
function renderHeader() {
  document.title = `${state.data.label} · ${$('app').textContent} Feedback`;
}

function renderStats() {
  const d = state.data;
  const c = d.current;
  const p = d.previous;
  const before = MONTHS[monthOf(p.from) - 1];
  // A month without feedback, such as one before the store existed, is no comparison.
  const compare = d.months.includes(p.from.slice(0, 7));
  let scope = `Keine Vormonatswerte, im ${before} gab es kein Feedback.`;
  if (compare) {
    scope = d.period.running
      ? `Vormonatswerte für denselben Zeitraum (${days(p.to)} ${before}).`
      : `Vormonatswerte für den ganzen ${before}.`;
  }
  $('period').textContent = d.period.running
    ? `Laufender Monat, Stand ${dayOf(d.period.to)}. ${MONTHS[monthOf(d.period.from) - 1]}. ${scope}`
    : `Abgeschlossener Monat. ${scope}`;
  const vs = (value) => (compare ? `Vormonat: ${value}` : '');
  $('k-rated').textContent = int(c.rated);
  $('p-rated').textContent = vs(int(p.rated));
  const positive = share(c.up, num(c.rated));
  $('k-positive').textContent = positive ?? '–';
  $('p-positive').textContent = positive
    ? vs(share(p.up, num(p.rated)) ?? '–')
    : 'Erst ab 10 Bewertungen';
  $('k-down').textContent = int(c.down);
  $('p-down').textContent = vs(int(p.down));
  $('k-texts').textContent = int(c.texts);
  $('p-texts').textContent = [`${int(state.rows.length)} in der Liste`, vs(int(p.texts))]
    .filter(Boolean)
    .join(' · ');
}

function niceMax(max) {
  if (max <= 5) {
    return 5;
  }
  const step = 10 ** Math.floor(Math.log10(max));
  return (Math.ceil((max / step) * 2) * step) / 2;
}

function renderChart() {
  const d = state.data;
  const month = monthOf(d.period.from);
  const last = d.period.running ? dayOf(d.period.to) : d.days.length;
  const values = d.days.map(([up, down]) => [num(up), num(down)]);
  const top = niceMax(Math.max(0, ...values.slice(0, last).map(([up, down]) => up + down)));
  const [left, right, y0, y1] = [44, 996, 186, 12];
  const step = (right - left) / values.length;
  const y = (v) => y0 - (v / top) * (y0 - y1);
  let svg = [0, top / 2, top]
    .map(
      (v) =>
        `<line class="grid" x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${int(v)}</text>`,
    )
    .join('');
  // The rest of a running month is one quiet area, not a row of empty days.
  if (last < values.length) {
    const from = left + last * step;
    svg += `<rect class="future" x="${from}" y="${y1}" width="${right - from}" height="${y0 - y1}" rx="6"/>`;
    if (right - from > 160) {
      svg += `<text x="${(from + right) / 2}" y="${(y0 + y1) / 2 + 4}" text-anchor="middle">Rest des Monats</text>`;
    }
  }
  values.forEach(([up, down], i) => {
    const x = left + i * step + 3;
    const width = Math.max(2, step - 6);
    if (i < last) {
      const title = `<title>${i + 1}. ${SHORT[month - 1]}: ${up} hoch, ${down} runter</title>`;
      const hu = y0 - y(up);
      const hd = y0 - y(down);
      svg += `<g>${title}<rect class="up" x="${x}" y="${y0 - hu}" width="${width}" height="${hu}" rx="3"/>`;
      svg += `<rect class="down" x="${x}" y="${y0 - hu - hd - (hd ? 2 : 0)}" width="${width}" height="${hd}" rx="3"/></g>`;
    }
    if (i === 0 || (i + 1) % 5 === 0) {
      svg += `<text x="${x + width / 2}" y="210" text-anchor="middle">${i + 1}.</text>`;
    }
  });
  if (!values.slice(0, last).some(([up, down]) => up + down)) {
    svg += `<text class="empty" x="${(left + right) / 2}" y="${(y0 + y1) / 2}" text-anchor="middle">Noch keine Bewertungen in diesem Zeitraum</text>`;
  }
  $('chart').innerHTML = svg;
  $('chart-table').innerHTML =
    '<caption>Bewertungen pro Tag</caption><tr><th>Tag</th><th>Daumen hoch</th><th>Daumen runter</th></tr>' +
    values
      .slice(0, last)
      .map(
        ([up, down], i) =>
          `<tr><td>${i + 1}. ${SHORT[month - 1]}</td><td>${up}</td><td>${down}</td></tr>`,
      )
      .join('');
}

function renderReasons() {
  for (const [rating, list, color] of [
    ['thumbsDown', 'r-down', 'var(--down)'],
    ['thumbsUp', 'r-up', 'var(--up)'],
  ]) {
    const rows = Object.entries(state.data.reasons[rating] || {})
      .map(([key, n]) => [key, num(n)])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((sum, [, n]) => sum + n, 0);
    $(list).innerHTML = rows.length
      ? rows
          .map(
            ([key, n]) =>
              `<li><span>${esc(REASONS[key] || key)}</span><span class="num"><b>${int(n)}</b> · ${Math.round((100 * n) / total)} %</span>` +
              `<span class="track" aria-hidden="true"><i style="width:${Math.round((100 * n) / rows[0][1])}%;background:${color}"></i></span></li>`,
          )
          .join('')
      : '<li class="empty">Keine Bewertungen</li>';
  }
}

function visibleRows(query) {
  return state.rows.filter(
    (r) =>
      r.id === state.open?.id ||
      ((!state.rating || r.rating === state.rating) &&
        (!state.hintsOnly || r.hints.length > 0) &&
        (!query || r.text.toLowerCase().includes(query))),
  );
}

function rowElement(r, query) {
  const li = document.createElement('li');
  li.className = state.arrived.has(r.id) ? 'row arrived' : 'row';
  li.dataset.id = r.id;
  const when = `vom ${dm(r.date)}`;
  const tags = [
    `<span class="badge">${esc(REASONS[r.reason] || r.reason)}</span>`,
    r.hints.length ? '<span class="badge hint">Prüfen</span>' : '',
    r.cleaned ? '<span class="badge cleaned">Bereinigt</span>' : '',
    r.today ? `<span class="badge" title="${TODAY_NOTE}">Heute</span>` : '',
  ].join('');
  li.innerHTML =
    `<div class="date"><time datetime="${r.date}">${dm(r.date)}</time>${r.isNew ? '<br><span class="badge new">Neu</span>' : ''}</div>` +
    `<div class="rating">${ICON[r.rating] || ''}</div>` +
    `<div class="body"><p class="text">${highlight(r.text, query, r.hints)}</p><div class="tags">${tags}</div></div>` +
    '<div class="actions">' +
    `<button type="button" class="ghost" data-act="clean" aria-label="Freitext ${when} bereinigen">${ICON.clean}<span>Bereinigen</span></button>` +
    `<button type="button" class="ghost danger" data-act="delete" aria-label="Freitext ${when} löschen">${ICON.trash}<span>Löschen</span></button>` +
    '</div>';
  return li;
}

function renderTexts() {
  const query = $('filter').value.trim().toLowerCase();
  const list = $('list');
  const active = document.activeElement;
  const focusRow = active?.closest?.('.row')?.dataset.id;
  const focusAct = active?.dataset?.act;
  const openRow = state.open ? list.querySelector(`[data-id="${state.open.id}"]`) : null;

  const rows = visibleRows(query);
  const fragment = document.createDocumentFragment();
  rows.slice(0, state.shown).forEach((r) => {
    fragment.append(r.id === state.open?.id && openRow ? openRow : rowElement(r, query));
  });
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.innerHTML = state.rows.length
      ? '<p>Keine Freitexte passen zu Ihrer Auswahl.</p><button type="button" class="btn" data-reset>Auswahl zurücksetzen</button>'
      : `<p>Noch keine Freitexte in diesem Monat.</p>${state.data.period.running ? '<p>Neue erscheinen hier automatisch.</p>' : ''}`;
    fragment.append(empty);
  }
  list.replaceChildren(fragment);
  state.arrived.clear();

  const rest = rows.length - state.shown;
  $('list-foot').innerHTML =
    rest > 0
      ? `<button type="button" class="btn" id="more">Weitere ${Math.min(PAGE, rest)} von ${rest} anzeigen</button>`
      : '';
  $('t-count').textContent = `${int(state.rows.length)} in der Liste`;
  const hinted = state.rows.filter((r) => r.hints.length > 0).length;
  $('hints-count').textContent = `(${int(hinted)})`;

  if (focusRow && focusAct) {
    list
      .querySelector(`[data-id="${focusRow}"] [data-act="${focusAct}"]`)
      ?.focus({ preventScroll: true });
  }
}

const rowOf = (id) => state.rows.find((r) => r.id === id);

/** Keeps the month in memory in step with a deleted or cleaned text. */
function patchCached(date, change) {
  const entry = state.cache.get(date.slice(0, 7));
  if (entry) {
    entry.data.texts = change(entry.data.texts);
  }
}
const liOf = (id) => $('list').querySelector(`[data-id="${id}"]`);

function openWork(id, mode) {
  if (state.open) {
    closeWork(false);
  }
  const r = rowOf(id);
  const li = liOf(id);
  if (!r || !li) {
    return;
  }
  state.open = { id, mode };
  const when = `vom ${dm(r.date)}`;
  const panel = document.createElement('div');
  panel.className = mode === 'delete' ? 'work confirm' : 'work';
  if (mode === 'clean') {
    const draft = state.drafts.get(id);
    panel.innerHTML =
      `<label class="sr-only" for="edit-${id}">Bereinigter Freitext ${when}</label>` +
      `<textarea id="edit-${id}" maxlength="500" aria-describedby="edit-hint-${id}"></textarea>` +
      `<p class="hint-line" id="edit-hint-${id}">Personenangaben markieren und durch ${MARKER} ersetzen. Im Zweifel den ganzen Text ersetzen.</p>` +
      (r.today ? `<p class="today">${TODAY_NOTE}</p>` : '') +
      (draft !== undefined
        ? '<p class="hint-line">Ihr Entwurf von vorhin ist wiederhergestellt.</p>'
        : '') +
      '<div class="work-actions">' +
      '<button type="button" class="btn" data-work="mark">Markierung ersetzen</button>' +
      '<button type="button" class="btn" data-work="all">Ganzen Text ersetzen</button>' +
      '<span class="grow"></span>' +
      '<button type="button" class="btn" data-work="cancel">Abbrechen</button>' +
      '<button type="button" class="btn submit" data-work="save">Speichern</button>' +
      '</div><p class="error" role="alert"></p>';
    li.querySelector('.body').append(panel);
    const area = panel.querySelector('textarea');
    area.value = draft ?? r.text;
    updateSave(panel, r);
    area.focus();
  } else {
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-labelledby', `confirm-${id}`);
    panel.innerHTML =
      `<p id="confirm-${id}"><strong>Diesen Freitext löschen?</strong> Die Bewertung bleibt gezählt, und die Aktion wird mit Ihrer Kennung protokolliert. Ein Versehen kann der Betrieb zwei Tage lang rückgängig machen.</p>` +
      (r.today ? `<p class="today">${TODAY_NOTE}</p>` : '') +
      '<div class="work-actions">' +
      '<button type="button" class="btn" data-work="cancel">Abbrechen</button>' +
      `<button type="button" class="btn destructive" data-work="delete">Freitext ${when} löschen</button>` +
      '</div><p class="error" role="alert"></p>';
    li.querySelector('.body').append(panel);
    panel.querySelector('[data-work="cancel"]').focus();
  }
  li.querySelector('.actions').hidden = true;
}

function closeWork(restoreFocus = true) {
  if (!state.open) {
    return;
  }
  const { id, mode } = state.open;
  const li = liOf(id);
  const area = li?.querySelector('textarea');
  const r = rowOf(id);
  if (area && r && area.value.trim() !== r.text) {
    state.drafts.set(id, area.value);
  }
  li?.querySelector('.work')?.remove();
  if (li) {
    li.querySelector('.actions').hidden = false;
  }
  state.open = null;
  if (restoreFocus) {
    li?.querySelector(`[data-act="${mode}"]`)?.focus();
  }
}

function updateSave(panel, r) {
  const value = panel.querySelector('textarea').value.trim();
  panel.querySelector('[data-work="save"]').disabled = !value || value === r.text;
}

async function post(id, action, body) {
  const res = await fetch(`api/texts/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Feedback-Review': '1' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function failure(error, action) {
  if (error.status === 409) {
    return action === 'clean'
      ? 'Noch nicht möglich: Der Text ist erst vor Kurzem eingegangen. Bitte in etwa 90 Minuten erneut speichern; Ihr Entwurf bleibt erhalten, solange diese Seite offen ist.'
      : 'Noch nicht möglich: Der Text ist erst vor Kurzem eingegangen. Bitte in etwa 90 Minuten erneut löschen.';
  }
  return 'Das hat nicht geklappt. Bitte erneut versuchen.';
}

async function run(button, action) {
  const { id } = state.open;
  const r = rowOf(id);
  const li = liOf(id);
  const panel = li.querySelector('.work');
  const buttons = panel.querySelectorAll('button');
  const text = action === 'clean' ? panel.querySelector('textarea').value.trim() : undefined;
  buttons.forEach((b) => {
    b.disabled = true;
  });
  button.setAttribute('aria-busy', 'true');
  panel.querySelector('.error').textContent = '';
  const when = `vom ${dm(r.date)}`;
  try {
    const result = await post(id, action, action === 'clean' ? { text } : undefined);
    state.open = null;
    state.drafts.delete(id);
    if (action === 'delete') {
      const next = li.nextElementSibling?.dataset.id || li.previousElementSibling?.dataset.id;
      li.classList.add('leaving');
      await new Promise((resolve) =>
        setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180),
      );
      state.rows = state.rows.filter((row) => row.id !== id);
      patchCached(r.date, (texts) => texts.filter((t) => t.id !== id));
      renderTexts();
      renderStats();
      (next ? liOf(next)?.querySelector('[data-act="delete"]') : $('texts-title'))?.focus();
      toast(`Freitext ${when} gelöscht.`);
    } else {
      Object.assign(r, {
        text: result.text,
        cleaned: result.text.includes(MARKER),
        hints: findHints(result.text),
      });
      patchCached(r.date, (texts) =>
        texts.map((t) => (t.id === id ? { ...t, text: result.text } : t)),
      );
      renderTexts();
      liOf(id)?.querySelector('[data-act="clean"]')?.focus();
      toast(`Freitext ${when} bereinigt.`);
    }
  } catch (error) {
    if (error.status === 404) {
      state.open = null;
      state.rows = state.rows.filter((row) => row.id !== id);
      patchCached(r.date, (texts) => texts.filter((t) => t.id !== id));
      renderTexts();
      toast('Dieser Freitext ist schon gelöscht.');
      $('texts-title').focus();
      return;
    }
    if (action === 'clean') {
      state.drafts.set(id, text);
    }
    panel.querySelector('.error').textContent = failure(error, action);
    buttons.forEach((b) => {
      b.disabled = false;
    });
    if (action === 'clean') {
      updateSave(panel, r);
    }
    button.removeAttribute('aria-busy');
  }
}

$('list').addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target) {
    return;
  }
  if (target.hasAttribute('data-reset')) {
    $('filter').value = '';
    state.rating = '';
    state.hintsOnly = false;
    syncFilters();
    renderTexts();
    $('filter').focus();
    return;
  }
  const id = target.closest('.row')?.dataset.id;
  if (target.dataset.act) {
    openWork(id, target.dataset.act);
    return;
  }
  const panel = target.closest('.work');
  const area = panel?.querySelector('textarea');
  switch (target.dataset.work) {
    case 'cancel':
      closeWork();
      break;
    case 'mark': {
      const { selectionStart: start, selectionEnd: end } = area;
      if (start === end) {
        panel.querySelector('.error').textContent =
          'Markieren Sie zuerst den Teil, der ersetzt werden soll.';
        area.focus();
        break;
      }
      area.setRangeText(MARKER, start, end, 'end');
      panel.querySelector('.error').textContent = '';
      updateSave(panel, rowOf(id));
      area.focus();
      break;
    }
    case 'all':
      area.value = MARKER;
      updateSave(panel, rowOf(id));
      area.focus();
      break;
    case 'save':
      run(target, 'clean');
      break;
    case 'delete':
      run(target, 'delete');
      break;
    default:
  }
});

$('list').addEventListener('input', (event) => {
  if (event.target.matches('.work textarea')) {
    updateSave(event.target.closest('.work'), rowOf(state.open.id));
  }
});

$('list-foot').addEventListener('click', (event) => {
  if (event.target.closest('#more')) {
    state.shown += PAGE;
    renderTexts();
  }
});

function syncFilters() {
  document.querySelectorAll('.seg button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.rating === state.rating));
  });
  $('hints-only').setAttribute('aria-pressed', String(state.hintsOnly));
}

document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    state.rating = b.dataset.rating;
    state.shown = PAGE;
    syncFilters();
    renderTexts();
  }),
);
$('hints-only').addEventListener('click', () => {
  state.hintsOnly = !state.hintsOnly;
  state.shown = PAGE;
  syncFilters();
  renderTexts();
});
$('filter').addEventListener('input', () => {
  state.shown = PAGE;
  if (state.data) {
    renderTexts();
  }
});
$('month-button').addEventListener('click', () =>
  $('month-pop').hidden ? openPicker() : closePicker(true),
);
$('month-grid').addEventListener('click', (event) => {
  const cell = event.target.closest('button');
  if (cell && !cell.disabled) {
    closePicker(true);
    navigate(cell.dataset.month);
  }
});
$('month-grid').addEventListener('keydown', moveInGrid);
$('year-prev').addEventListener('click', () => changeYear(-1));
$('year-next').addEventListener('click', () => changeYear(1));
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#month-pop, #month-button')) {
    closePicker(false);
  }
});
$('month-pop').addEventListener('focusout', (event) => {
  if (event.relatedTarget && !event.relatedTarget.closest('#month-pop, #month-button')) {
    closePicker(false);
  }
});
$('prev').addEventListener('click', () => navigate($('prev').dataset.month));
$('next').addEventListener('click', () => navigate($('next').dataset.month));
$('retry').addEventListener('click', () => {
  const month = state.failed || state.want;
  history.replaceState(null, '', `?m=${month}`);
  show(month);
});

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    $('filter').focus();
  } else if (event.key === 'Escape' && !$('month-pop').hidden) {
    event.preventDefault();
    closePicker(true);
  } else if (event.key === 'Escape' && state.open) {
    event.preventDefault();
    closeWork();
  }
});

document.addEventListener('visibilitychange', () => {
  const at = state.data ? state.cache.get(state.data.month)?.at : 0;
  if (!document.hidden && state.data?.period.running && Date.now() - (at || 0) >= REFRESH_MS) {
    poll();
  }
});

// Same switch as LibreChat: a .dark class on <html>, set before the first paint by theme.js.
const system = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const theme = storage((s) => s.getItem(THEME_KEY));
  document.documentElement.classList.toggle('dark', theme ? theme === 'dark' : system.matches);
  document.querySelectorAll('.theme button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.theme === (theme || 'system')));
  });
}
document.querySelectorAll('.theme button').forEach((b) =>
  b.addEventListener('click', () => {
    storage((s) =>
      b.dataset.theme === 'system'
        ? s.removeItem(THEME_KEY)
        : s.setItem(THEME_KEY, b.dataset.theme),
    );
    applyTheme();
  }),
);
system.addEventListener('change', applyTheme);
applyTheme();

// The server writes the month into the page; the clock is only a fallback.
const initial = $('month-button').dataset.month || berlinMonth();
renderMonths([initial]);
show(initial);
