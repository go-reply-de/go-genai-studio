/**
 * The monitoring report: the monitoring page's figures for the month before, as one HTML file in the
 * report bucket and one log line with the key figures, which the setup repo's alert mails. It uses
 * the page's own code (feedback.js, usage.js), so report and page show the same numbers.
 *
 * Counts only. The comments are read to count those with possible personal data that nobody has
 * checked yet, and are never written, logged or mailed: a cleaned or deleted comment must not
 * survive in a report.
 *
 * Runs as the CronJob in k8s/monitoring-report.yaml. Local runs write to OUT_DIR instead.
 */
const fs = require('fs');
const path = require('path');
const TEXTS = require('./public/i18n');
const { findHints } = require('./public/hints');
const { createFeedback } = require('./feedback');
const { createGoogle } = require('./google');
const { createUsage } = require('./usage');

const T = TEXTS.de;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** The positive share is shown from this many ratings on, as on the page. */
const MIN_RATINGS = 10;
const UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b';

const pad = (n) => String(n).padStart(2, '0');
const t = (key, values = {}) => T[key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
const int = (n) => Math.round(Number(n) || 0).toLocaleString('de-DE');
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const monthName = (key) => `${T.months[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
const significant = new Intl.NumberFormat('de-DE', { maximumSignificantDigits: 3 });
/** Token counts run into millions; three significant digits read best in a mail. */
const amount = (n) => (n >= 1e6 ? `${significant.format(n / 1e6)} Mio.` : int(n));
/** One decimal; a share that is there but rounds to nothing reads as under 0.1 per cent. */
const percent = (part, whole) => {
  const value = (100 * part) / whole;
  if (part > 0 && value < 0.05) {
    return '< 0,1 %';
  }
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
};
const positiveShare = ({ rated, up }) => (rated >= MIN_RATINGS ? percent(up, rated) : '–');
const change = (now, before) => {
  if (!before) {
    return '';
  }
  const p = Math.round((100 * (now - before)) / before);
  return ` · ${p > 0 ? '+' : ''}${p} %`;
};
const berlin = (date, options) =>
  new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', ...options }).format(date);

/** The month to report: REPORT_MONTH, else the calendar month before `now` in Berlin. */
function reportMonth(asked, now) {
  if (asked) {
    const match = MONTH.exec(asked);
    if (!match) {
      throw new Error(`REPORT_MONTH must be YYYY-MM, not ${asked}`);
    }
    return [Number(match[1]), Number(match[2])];
  }
  const [y, m] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);
  return m === 1 ? [y - 1, 12] : [y, m - 1];
}

/** Tokens of the month by purpose or by model, biggest input first. */
function tokenGroups(days, split) {
  const groups = new Map();
  for (const [purpose, model, input, output] of days.flatMap((d) => d?.tokens || [])) {
    const key = split === 'model' ? model : purpose;
    const g = groups.get(key) || { key, input: 0, output: 0 };
    g.input += input;
    g.output += output;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.input - a.input);
}

const DAY = 24 * 60 * 60 * 1000;

/** A week's conversations on all seven days, also those in the neighbouring months. */
function weekConversations(week, span) {
  const start = Math.round((Date.parse(week.from) - Date.parse(span.period.from)) / DAY);
  const days = span.days.slice(Math.max(0, start), start + 7).filter(Boolean);
  return days.length ? days.reduce((sum, d) => sum + d.conversations, 0) : null;
}

/**
 * Everything the report shows, as counts. The comments are only counted here and go no further.
 */
function figures({ key, fb, use, span, env }) {
  const weeks = use.weeks.map((w) => ({
    ...w,
    users: w.users ?? null,
    conversations: span ? weekConversations(w, span) : null,
  }));
  const values = weeks.filter((w) => w.users !== null && !w.running).map((w) => w.users);
  const unchecked = fb.texts.filter((c) => !c.reviewed && findHints(c.text).length > 0).length;
  return {
    key,
    previousKey: fb.previous.from.slice(0, 7),
    feedback: { current: fb.current, previous: fb.previous, reasons: fb.reasons, unchecked },
    usage: {
      totals: use.totals,
      previous: use.previous,
      weeks,
      users: values.length ? [Math.min(...values), Math.max(...values)] : null,
      tokens: use.totals.recorded ? tokenGroups(use.days, env.USAGE_TOKEN_SPLIT) : [],
      split: env.USAGE_TOKEN_SPLIT === 'model' ? 'model' : 'purpose',
    },
  };
}

const usersRange = (users) => {
  if (!users) {
    return '–';
  }
  return users[0] === users[1] ? int(users[0]) : `${int(users[0])} bis ${int(users[1])}`;
};

/** The key figures for the mail, as the alert reads them from the log line. */
function summary(data, object, page) {
  const { feedback: f, usage: u } = data;
  const before = u.previous ? ` (Vormonat ${int(u.previous.conversations)})` : '';
  const users = u.users ? `${usersRange(u.users)} Nutzer je Woche` : 'keine Nutzerzahlen';
  const share =
    f.current.rated >= MIN_RATINGS
      ? `${positiveShare(f.current)} positiv`
      : 'Anteil positiv erst ab 10 Bewertungen';
  return {
    month: monthName(data.key),
    // Whole lines for the mail, so the alert needs only a few values from this line.
    usage: `${int(u.totals.conversations)} Unterhaltungen begonnen${before}, ${int(u.totals.messages)} Nachrichten, ${users}`,
    feedback: `${int(f.current.rated)} Bewertungen (${int(f.current.up)} Daumen hoch, ${int(f.current.down)} Daumen runter), ${share}`,
    comments: `${int(f.current.texts)} eingegangen, davon ${int(f.unchecked)} mit möglichen Personenangaben noch nicht geprüft`,
    conversations: int(u.totals.conversations),
    conversationsBefore: u.previous ? int(u.previous.conversations) : '–',
    messages: int(u.totals.messages),
    users: usersRange(u.users),
    ratings: int(f.current.rated),
    up: int(f.current.up),
    down: int(f.current.down),
    positive: positiveShare(f.current),
    texts: int(f.current.texts),
    unchecked: int(f.unchecked),
    input: u.totals.recorded ? amount(u.totals.input) : 'nicht erfasst',
    object,
    page,
  };
}

const bars = (rows) => {
  const top = Math.max(1, ...rows.map((r) => r.value));
  return rows
    .map(
      (r) =>
        `<div class="bar"><span>${r.label}</span><span class="track"><i style="width:${Math.round((100 * r.value) / top)}%"></i></span><span class="v">${int(r.value)}</span></div>`,
    )
    .join('');
};

const STYLE = `
body { margin: 0; background: #f7f7f8; color: #212121; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 900px; margin: 24px auto; padding: 32px 40px; background: #fff; border: 1px solid #e3e3e3; border-radius: 12px; }
h1 { font-size: 24px; margin: 0; }
h2 { font-size: 17px; margin: 28px 0 10px; }
h3 { font-size: 14px; margin: 16px 0 6px; color: #424242; }
.sub, .note { color: #595959; }
.note { font-size: 12px; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.kpi { background: #f7f7f8; border-radius: 8px; padding: 10px 12px; }
.kpi p { margin: 0; }
.kpi .l { font-size: 12px; color: #595959; }
.kpi .v { font-size: 20px; font-weight: 600; }
.kpi .c { font-size: 12px; color: #595959; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 5px 6px; border-bottom: 1px solid #ececec; text-align: right; }
th:first-child, td:first-child { text-align: left; }
td + td, .nb { white-space: nowrap; }
th { font-weight: 600; color: #595959; }
.bar { display: grid; grid-template-columns: 13rem minmax(0, 1fr) 3.5rem; gap: 10px; align-items: center; padding: 3px 0; font-variant-numeric: tabular-nums; }
.track { height: 7px; border-radius: 9px; background: #ececec; overflow: hidden; }
.track i { display: block; height: 100%; border-radius: 9px; background: #595959; }
.bar .v { text-align: right; }
.weeks small { color: #595959; margin-left: 6px; }
.box { border: 1px solid #e3e3e3; border-radius: 10px; padding: 12px 14px; margin-top: 14px; }
.box strong { font-variant-numeric: tabular-nums; }
a { color: #0c66e4; }
@media (max-width: 640px) { main { margin: 0; padding: 20px 16px; border: 0; border-radius: 0; } .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .cols { grid-template-columns: minmax(0, 1fr); gap: 0; } .bar { grid-template-columns: 8.5rem minmax(0, 1fr) 3rem; } }
@page { size: A4; margin: 14mm; }
@media print { body { background: #fff; font-size: 13px; } main { border: 0; margin: 0; padding: 0; max-width: none; } h2 { margin: 18px 0 8px; } .bar { padding: 1px 0; line-height: 1.3; } }
`;

/** The report page itself, in German like its readers. */
function renderReport(data, { env, created, page }) {
  const { feedback: f, usage: u } = data;
  const app = esc(env.APP_TITLE || 'DiMeAs');
  const before = monthName(data.previousKey);
  const vs = (now, then) => (then === undefined ? '' : `Vormonat ${int(then)}${change(now, then)}`);
  const kpi = (label, value, note) =>
    `<div class="kpi"><p class="l">${label}</p><p class="v">${value}</p><p class="c">${note}</p></div>`;
  const tokenNote = u.previous?.recorded
    ? `Vormonat ${amount(u.previous.input)}`
    : 'Vormonat nicht erfasst';
  const reasons = Object.entries(f.reasons.thumbsDown || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ label: esc(T.reasons[key] || key), value }));
  const count = (n) => (n === null ? '–' : int(n));
  const weekRows = u.weeks.length
    ? [...u.weeks]
        .reverse()
        .map(
          (w) =>
            `<tr><td>${esc(t('kw', { n: w.kw }))}<small>${esc(weekDates(w))}${w.running ? ', bisher' : ''}</small></td><td>${count(w.conversations)}</td><td>${count(w.users)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="3">Keine Wochenzahlen für diesen Monat.</td></tr>';
  const tokenRows = u.tokens.length
    ? u.tokens
        .map((g) => {
          const label = u.split === 'model' ? g.key : T.purposes[g.key] || g.key;
          const total = u.tokens.reduce((s, x) => s + x.input, 0);
          return `<tr><td>${esc(label)}</td><td>${int(g.input)}</td><td>${int(g.output)}</td><td>${esc(percent(g.input, total))}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="4">Für diesen Monat gibt es keine Tokendaten.</td></tr>';
  const link = `${page}?m=${data.key}`;
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${app} Monatsbericht ${esc(monthName(data.key))}</title><style>${STYLE}</style></head>
<body><main>
<h1>${app} Monatsbericht ${esc(monthName(data.key))}</h1>
<p class="sub">${esc(env.ENVIRONMENT || '')} · erstellt am ${esc(created)} · Vergleich mit ${esc(before)}</p>

<h2>Überblick</h2>
<div class="kpis">
${kpi('Unterhaltungen begonnen', int(u.totals.conversations), vs(u.totals.conversations, u.previous?.conversations))}
${kpi('Nachrichten', int(u.totals.messages), vs(u.totals.messages, u.previous?.messages))}
${kpi('Bewertungen', int(f.current.rated), `${vs(f.current.rated, f.previous.rated)} · ${f.current.rated >= MIN_RATINGS ? `<span class="nb">${positiveShare(f.current)} positiv</span>` : 'Anteil positiv erst ab 10 Bewertungen'}`)}
${kpi('Eingabe-Tokens', u.totals.recorded ? amount(u.totals.input) : 'nicht erfasst', tokenNote)}
</div>

<div class="cols">
<section>
<h2>Feedback</h2>
<table><thead><tr><th>Kennzahl</th><th>${esc(T.short[Number(data.key.slice(5)) - 1])}</th><th>${esc(T.short[Number(data.previousKey.slice(5)) - 1])}</th></tr></thead><tbody>
<tr><td>Bewertungen</td><td>${int(f.current.rated)}</td><td>${int(f.previous.rated)}</td></tr>
<tr><td>Anteil positiv</td><td>${positiveShare(f.current)}</td><td>${positiveShare(f.previous)}</td></tr>
<tr><td>Daumen runter</td><td>${int(f.current.down)}</td><td>${int(f.previous.down)}</td></tr>
</tbody></table>
<h3>Gründe für Daumen runter</h3>
${reasons.length ? bars(reasons) : '<p class="note">Keine Bewertungen mit Daumen runter.</p>'}
<div class="box">
<h3 style="margin-top:0">Freitexte</h3>
<table><tbody>
<tr><td>Eingegangen</td><td><strong>${int(f.current.texts)}</strong></td></tr>
<tr><td>Mögliche Personenangaben, noch nicht geprüft</td><td><strong>${int(f.unchecked)}</strong></td></tr>
</tbody></table>
<p>Lesen, bereinigen und prüfen auf der Monitoring-Seite: <a href="${esc(link)}">${esc(link)}</a></p>
<p class="note">Der Bericht enthält keine Freitexte, damit gelöschte oder bereinigte Texte nirgends als Kopie bleiben.</p>
</div>
</section>
<section>
<h2>Nutzung</h2>
<h3>Je Woche</h3>
<table class="weeks"><thead><tr><th>Woche</th><th>Unterhaltungen</th><th>Nutzer</th></tr></thead><tbody>
${weekRows}
</tbody></table>
<h2>Tokens nach ${u.split === 'model' ? 'Modell' : 'Verwendung'}</h2>
<table><thead><tr><th>${u.split === 'model' ? 'Modell' : 'Verwendung'}</th><th>Eingabe</th><th>Ausgabe</th><th>Anteil</th></tr></thead><tbody>
${tokenRows}
</tbody></table>
</section>
</div>


<h2>Hinweise</h2>
<p class="note">Jede Person zählt einmal pro Woche, egal wie oft sie schreibt; die Wochen ergeben darum zusammen keine Nutzerzahl für den Monat. Eine Woche über einen Monatswechsel zählt mit allen sieben Tagen und steht bei dem Monat, in dem die meisten ihrer Tage liegen. Der Bericht enthält nur Zahlen; Freitexte bleiben auf der Monitoring-Seite.</p>
</main></body></html>
`;
}

/** A week's dates, with one month name unless the week spans two. */
function weekDates({ from, to }) {
  const [fm, fd] = [Number(from.slice(5, 7)), Number(from.slice(8))];
  const [tm, td] = [Number(to.slice(5, 7)), Number(to.slice(8))];
  return fm === tm ? `${fd}.–${td}. ${T.short[tm - 1]}` : `${fd}.${fm}.–${td}.${tm}.`;
}

/**
 * Adds the report to the bucket unless it exists already: ifGenerationMatch=0 makes Cloud Storage
 * refuse an existing name, and the job may add objects but never replace them.
 */
async function upload({ fetchFn, credentials, bucket }, name, html) {
  const { token } = await credentials();
  const query = new URLSearchParams({ uploadType: 'media', name, ifGenerationMatch: '0' });
  const res = await fetchFn(`${UPLOAD}/${encodeURIComponent(bucket)}/o?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  });
  if (res.status === 412) {
    return 'exists';
  }
  if (!res.ok) {
    throw new Error(`Cloud Storage HTTP ${res.status}`);
  }
  return 'ok';
}

/** The report for one month; feedback, usage, upload and log are swapped in tests. */
function createReport({ env, now = () => new Date(), feedback, usage, upload: put, log }) {
  async function run() {
    const [y, m] = reportMonth(env.REPORT_MONTH, now());
    const key = `${y}-${pad(m)}`;
    const [fb, use] = await Promise.all([feedback.monthView(y, m), usage.view(key)]);
    // The month's whole weeks, which reach into the months around it.
    const span = use.weeks.length
      ? await usage.interval(use.weeks[0].from, use.weeks.at(-1).to)
      : null;
    const data = figures({ key, fb, use, span, env });
    const object = `reports/monatsbericht-${key}.html`;
    const page = env.PAGE_URL || '';
    const created = `${berlin(now(), { day: 'numeric', month: 'long', year: 'numeric' })}, ${berlin(now(), { hour: '2-digit', minute: '2-digit' })} Uhr`;
    const result = await put(object, renderReport(data, { env, created, page }));
    if (result === 'exists') {
      log('WARNING', 'monitoring report already exists, not overwritten', { object });
      return;
    }
    log('NOTICE', 'monitoring report written', {
      monitoringReport: summary(data, object, `${page}?m=${key}`),
    });
  }
  return { run };
}

function writeLog(severity, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ severity, message, ...fields })}\n`);
}

if (require.main === module) {
  const env = process.env;
  const { credentials, query, table } = createGoogle({
    fetchFn: fetch,
    dataset: env.FEEDBACK_DATASET?.trim() || 'feedback',
  });
  const outDir = env.OUT_DIR;
  const report = createReport({
    env,
    feedback: createFeedback({ query, table }),
    usage: createUsage({ credentials, fetchFn: fetch }),
    upload: outDir
      ? async (name, html) => {
          fs.mkdirSync(path.join(outDir, path.dirname(name)), { recursive: true });
          fs.writeFileSync(path.join(outDir, name), html);
          return 'ok';
        }
      : (name, html) =>
          upload({ fetchFn: fetch, credentials, bucket: env.REPORT_BUCKET }, name, html),
    log: writeLog,
  });
  report.run().catch((error) => {
    writeLog('ERROR', 'monitoring report failed', { detail: String(error.message).slice(0, 2000) });
    process.exitCode = 1;
  });
}

module.exports = { createReport, upload, renderReport, reportMonth };
