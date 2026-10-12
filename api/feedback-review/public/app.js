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
const int = (n) => Number(n).toLocaleString('de-DE');
const pct = (part, whole) =>
  whole >= 10 ? ((100 * part) / whole).toFixed(1).replace('.', ',') + ' %' : '–';
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

let data = null;
let ratingFilter = '';
let selected = null;

function status(text, isError = false) {
  $('status').hidden = !text;
  $('status').classList.toggle('error', isError);
  $('status-text').textContent = text || '';
}

function fillMonths() {
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const option = document.createElement('option');
    option.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    option.textContent = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    $('month').append(option);
  }
}

async function load() {
  status('Lädt …');
  try {
    const res = await fetch(`api/month?m=${encodeURIComponent($('month').value)}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      throw new Error(
        res.status === 403
          ? 'Kein Zugriff.'
          : `Die Daten konnten nicht geladen werden (HTTP ${res.status}).`,
      );
    }
    data = await res.json();
    status('');
    renderHeader();
    renderOverview();
    renderTexts();
  } catch (err) {
    status(err.message || 'Die Daten konnten nicht geladen werden.', true);
  }
}

function renderHeader() {
  const app = data.application || 'Feedback';
  document.title = `${app} Feedback`;
  $('app').textContent = app;
  $('logo').textContent = app.charAt(0).toUpperCase();
  $('env').textContent = data.environment || '';
  $('user').textContent = data.user || '';
  $('avatar').textContent = (data.user || '?')
    .split('@')[0]
    .replace(/[^a-zA-Z]/g, '')
    .slice(0, 2);
}

function renderOverview() {
  const c = data.current,
    p = data.previous;
  $('k-rated').textContent = int(c.rated);
  $('p-rated').textContent = `${p.label}: ${int(p.rated)}`;
  $('k-positive').textContent = pct(c.up, c.rated);
  $('p-positive').textContent = `${p.label}: ${pct(p.up, p.rated)}`;
  $('k-down').textContent = int(c.down);
  $('p-down').textContent = `${p.label}: ${int(p.down)}`;
  $('k-texts').textContent = int(c.texts);
  $('p-texts').textContent = `${p.label}: ${int(p.texts)}`;

  const month = MONTHS[Number(data.month.slice(5)) - 1].slice(0, 3);
  const max = Math.max(1, ...data.days.map(([u, d]) => Math.max(0, u) + Math.max(0, d)));
  const w = 1000 / data.days.length,
    h = 150;
  $('chart').innerHTML = data.days
    .map(([u, d], i) => {
      const up = Math.max(0, u),
        down = Math.max(0, d);
      const x = i * w + 3,
        bw = Math.max(2, w - 6),
        hu = (up / max) * (h - 10),
        hd = (down / max) * (h - 10);
      const title = `<title>${i + 1}. ${month}.: ${u} hoch, ${d} runter</title>`;
      const label =
        i === 0 || (i + 1) % 5 === 0
          ? `<text x="${x + bw / 2}" y="174" text-anchor="middle">${i + 1}.</text>`
          : '';
      return (
        `<rect class="up" x="${x}" y="${h - hu}" width="${bw}" height="${hu}" rx="3">${title}</rect>` +
        `<rect class="down" x="${x}" y="${h - hu - hd - (hd ? 2 : 0)}" width="${bw}" height="${hd}" rx="3">${title}</rect>${label}`
      );
    })
    .join('');

  for (const [rating, el, side] of [
    ['thumbsDown', 'r-down', 'down'],
    ['thumbsUp', 'r-up', 'up'],
  ]) {
    const rows = Object.entries(data.reasons[rating] || {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    const top = rows[0] ? rows[0][1] : 1,
      all = rows.reduce((s, [, n]) => s + n, 0);
    $(el).innerHTML = rows.length
      ? rows
          .map(
            ([key, n]) =>
              `<div class="reason"><div><div>${esc(REASONS[key] || key)}</div>` +
              `<div class="track ${side}"><i style="width:${Math.round((n / top) * 100)}%"></i></div></div>` +
              `<div class="num">${int(n)}<small>${pct(n, all)}</small></div></div>`,
          )
          .join('')
      : '<div class="muted">Keine Bewertungen.</div>';
  }
}

function renderTexts() {
  const q = $('filter').value.trim().toLowerCase();
  const rows = data.texts.filter(
    (t) => (!ratingFilter || t.rating === ratingFilter) && (!q || t.text.toLowerCase().includes(q)),
  );
  $('t-count').textContent = `${rows.length} von ${data.texts.length}`;
  $('list').innerHTML = rows.length
    ? rows
        .map((t) => {
          const [, m, d] = t.date.split('-');
          const actions = t.state
            ? `<div class="done">${esc(t.state)}</div>`
            : `<div class="actions"><button class="btn" type="button" data-clean="${esc(t.id)}">${ICON.clean}Bereinigen</button>` +
              `<button class="btn danger" type="button" data-delete="${esc(t.id)}">${ICON.trash}Löschen</button></div>`;
          return (
            `<div class="row"><div class="date">${d}.${m}.</div><div>${ICON[t.rating] || ''}</div>` +
            `<div><div class="text">${esc(t.text)}</div><span class="chip">${esc(REASONS[t.reason] || t.reason)}</span></div>${actions}</div>`
          );
        })
        .join('')
    : `<div class="empty">${data.texts.length ? 'Keine Freitexte für diese Auswahl.' : 'Keine Freitexte in diesem Monat.'}</div>`;
}

async function act(action, body) {
  const res = await fetch(`api/texts/${encodeURIComponent(selected.id)}/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Feedback-Review': '1' },
    body: JSON.stringify(body || {}),
  });
  if (res.ok) {
    return res.json();
  }
  if (res.status === 409) {
    throw new Error(
      'Dieser Text ist noch keine 90 Minuten alt. BigQuery kann ihn erst danach ändern; bitte später erneut versuchen.',
    );
  }
  if (res.status === 404) {
    throw new Error('Der Text ist nicht mehr vorhanden.');
  }
  throw new Error(`Das hat nicht geklappt (HTTP ${res.status}).`);
}

async function runAction(button, errorEl, run) {
  button.setAttribute('aria-busy', 'true');
  errorEl.textContent = '';
  try {
    await run();
    closeDialogs();
    renderTexts();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    button.removeAttribute('aria-busy');
  }
}

function openDialog(id) {
  $(id).classList.add('open');
}

function closeDialogs() {
  document.querySelectorAll('.overlay').forEach((o) => o.classList.remove('open'));
  $('dd-error').textContent = '';
  $('dc-error').textContent = '';
}

$('list').addEventListener('click', (e) => {
  const del = e.target.closest('[data-delete]'),
    clean = e.target.closest('[data-clean]');
  if (del) {
    selected = data.texts.find((t) => t.id === del.dataset.delete);
    openDialog('dlg-delete');
    $('dd-ok').focus();
  }
  if (clean) {
    selected = data.texts.find((t) => t.id === clean.dataset.clean);
    $('dc-text').value = selected.text;
    openDialog('dlg-clean');
    $('dc-text').focus();
  }
});
$('dd-ok').addEventListener('click', () =>
  runAction($('dd-ok'), $('dd-error'), async () => {
    await act('delete');
    data.texts = data.texts.filter((t) => t !== selected);
  }),
);
$('dc-all').addEventListener('click', () => {
  $('dc-text').value = '[entfernt]';
});
$('dc-ok').addEventListener('click', () =>
  runAction($('dc-ok'), $('dc-error'), async () => {
    const result = await act('clean', { text: $('dc-text').value });
    selected.text = result.text;
    selected.state = 'Bereinigt';
  }),
);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDialogs));
document.querySelectorAll('.overlay').forEach((o) =>
  o.addEventListener('click', (e) => {
    if (e.target === o) closeDialogs();
  }),
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDialogs();
});
$('filter').addEventListener('input', () => data && renderTexts());
document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    ratingFilter = b.dataset.r;
    if (data) renderTexts();
  }),
);
$('month').addEventListener('change', load);

// Same switch as LibreChat: a .dark class on <html>; follows the system until toggled.
const THEME_KEY = 'feedback-theme';
const system = matchMedia('(prefers-color-scheme: dark)');
function stored() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}
function applyTheme() {
  const theme = stored();
  document.documentElement.classList.toggle('dark', theme ? theme === 'dark' : system.matches);
}
$('theme').addEventListener('click', () => {
  const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* the toggle still works for this page */
  }
  document.documentElement.classList.toggle('dark', next === 'dark');
});
system.addEventListener('change', applyTheme);
applyTheme();

fillMonths();
load();
