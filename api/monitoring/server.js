/**
 * Monitoring page with two tabs: Feedback, the counts and free texts of the BigQuery dataset in
 * FEEDBACK_DATASET, and Nutzung, the metrics exporter's series in Cloud Monitoring (usage.js).
 *
 * Runs from the API image under its own Kubernetes service account, which may read the feedback
 * tables, clean texts and read Cloud Monitoring; the API itself may only add rows. Only the load
 * balancer reaches this pod (see k8s/monitoring.yaml), so the reviewer's e-mail in IAP's header
 * can be trusted. Deletes, cleans and reviews are logged with that e-mail and the row id, never
 * with the text, and filtering happens in the browser, so no search term reaches BigQuery's
 * audit log.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const TEXTS = require('./public/i18n');
const { createFeedback } = require('./feedback');
const { createGoogle, QueryError } = require('./google');
const { createUsage } = require('./usage');

const PREFIX = '/monitoring';
const MAX_TEXT_LENGTH = 500;
const MAX_BODY = 8192;
const REMOVED = '[entfernt]';
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 3600e3;
/** Cloud Monitoring keeps the usage series for 24 months. */
const MAX_INTERVAL_DAYS = 731;
/** Finished months only change when a text is deleted or cleaned here, which clears them. */
const CACHE_MS = 5 * 60 * 1000;
/** Requests this close together share the running month, such as the page and its first data. */
const RECENT_MS = 5000;
const MAX_VIEWS = 48;
const ACTION = new RegExp(`^${PREFIX}/api/texts/([^/]+)/(delete|clean|review)$`);
const STATIC = {
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/hints.js': ['hints.js', 'text/javascript; charset=utf-8'],
  '/shell.js': ['shell.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/usage.js': ['usage.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
/** LibreChat's own Inter, from the client build in the image or its sources in a checkout. */
const FONTS = ['Inter-Regular.woff2', 'Inter-SemiBold.woff2', 'Inter-Bold.woff2'];
const FONT_DIRS = [
  path.join(__dirname, '..', '..', 'client', 'dist', 'assets', 'fonts'),
  path.join(__dirname, '..', '..', 'client', 'public', 'fonts'),
];
const HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
    "font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function log(severity, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ severity, message, ...fields })}\n`);
}

const pad = (n) => String(n).padStart(2, '0');
const stringParam = (value) => ({ type: 'STRING', value });
const boolParam = (value) => ({ type: 'BOOL', value: String(value) });
const berlinDay = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(date);
const LANG_COOKIE = /(?:^|;\s*)monitoring-lang=(de|en)(?:;|$)/;
const isDate = (s) =>
  DATE.test(s) && new Date(Date.parse(`${s}T00:00:00Z`) || 0).toISOString().startsWith(s);

/**
 * The interval in ?from=…&to=…: undefined when none is asked, null when it is not two real
 * dates in order, at most two years apart and starting by `today`.
 */
function askedInterval(url, today) {
  const [from, to] = ['from', 'to'].map((key) => url.searchParams.get(key));
  if (from === null && to === null) {
    return undefined;
  }
  if (!isDate(from || '') || !isDate(to || '') || from > to || from > today) {
    return null;
  }
  return Date.parse(to) - Date.parse(from) > MAX_INTERVAL_DAYS * DAY_MS ? null : { from, to };
}

/** The reviewer's choice from the page's switch, else the browser's first of German and English. */
function language(req) {
  const chosen = LANG_COOKIE.exec(req.headers.cookie || '');
  if (chosen) {
    return chosen[1];
  }
  const preferred = String(req.headers['accept-language'] || '')
    .split(',')
    .map((part) => part.trim().slice(0, 2).toLowerCase())
    .find((tag) => tag === 'de' || tag === 'en');
  return preferred || 'de';
}
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** The page and its API; `fetchFn`, `env` and the clock are swapped in tests. */
function createMonitoring({
  env = process.env,
  fetchFn = fetch,
  now = () => new Date(),
  staticDir = path.join(__dirname, 'public'),
  fontDirs = FONT_DIRS,
} = {}) {
  const dataset = env.FEEDBACK_DATASET?.trim() || 'feedback';
  // Where everyone uses the same agent and nobody picks a model, tokens split by what they were for.
  const split = env.USAGE_TOKEN_SPLIT?.trim() === 'purpose' ? 'purpose' : 'model';
  const pages = {
    feedback: fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8'),
    usage: fs.readFileSync(path.join(staticDir, 'usage.html'), 'utf8'),
  };
  const files = Object.fromEntries(
    Object.entries(STATIC).map(([route, [name, type]]) => [
      route,
      [fs.readFileSync(path.join(staticDir, name)), type],
    ]),
  );
  const fontDir = fontDirs.find((dir) => fs.existsSync(path.join(dir, FONTS[0])));
  if (!fontDir) {
    log('WARNING', 'Inter not found, the page falls back to the system font', { fontDirs });
  }
  const fonts = Object.fromEntries(
    fontDir
      ? FONTS.map((name) => [`/fonts/${name}`, fs.readFileSync(path.join(fontDir, name))])
      : [],
  );
  let months = { list: null, expires: 0 };
  const views = new Map();
  const at = () => now().getTime();
  const { credentials, query, table } = createGoogle({ fetchFn, dataset });
  const feedback = createFeedback({ query, table, now });
  // Cloud Monitoring is asked with the same pod token as BigQuery.
  const usage = createUsage({ credentials, fetchFn, now });

  /**
   * A month's view, shared by requests that ask while it loads. A text that changes clears all
   * of them, so a result still loading then is not kept.
   */
  async function cachedView(key, load) {
    const hit = views.get(key);
    if (hit && at() < hit.expires) {
      return hit.view;
    }
    const entry = { view: load(), expires: Infinity };
    views.delete(key);
    views.set(key, entry);
    if (views.size > MAX_VIEWS) {
      views.delete(views.keys().next().value);
    }
    try {
      const view = await entry.view;
      entry.expires = at() + (view.period.running ? RECENT_MS : CACHE_MS);
      return view;
    } catch (error) {
      if (views.get(key) === entry) {
        views.delete(key);
      }
      throw error;
    }
  }

  const cachedMonthView = (y, m) => cachedView(`${y}-${pad(m)}`, () => feedback.monthView(y, m));
  const cachedIntervalView = ({ from, to }) =>
    cachedView(`${from}_${to}`, () => feedback.intervalView(from, to));

  /** Months with feedback and their ratings, newest first; the running month is always one. */
  async function feedbackMonths() {
    if (at() >= months.expires) {
      const entry = {
        list: feedback.ratedMonths(),
        expires: Infinity,
      };
      months = entry;
      entry.list.then(
        () => {
          entry.expires = at() + CACHE_MS;
        },
        () => {
          if (months === entry) {
            months = { list: null, expires: 0 };
          }
        },
      );
    }
    const ratings = Object.fromEntries(await months.list);
    const running = berlinDay(now()).slice(0, 7);
    return {
      months: [...new Set([running, ...Object.keys(ratings)])].sort().reverse(),
      ratingsByMonth: { [running]: 0, ...ratings },
    };
  }

  /** A tab with its header written in, so it is complete before any data arrives. */
  function renderPage(page, reviewer, month, lang, span) {
    const texts = TEXTS[lang];
    const app = env.APP_TITLE?.trim() || 'Monitoring';
    const values = {
      LANG: lang,
      LANG_DE: String(lang === 'de'),
      LANG_EN: String(lang === 'en'),
      APP: app,
      LOGO: app.charAt(0).toUpperCase(),
      ENVIRONMENT: env.ENVIRONMENT || '',
      USER: reviewer,
      INITIALS: reviewer
        .split('@')[0]
        .replace(/[^a-zA-Z]/g, '')
        .slice(0, 2)
        .toUpperCase(),
      MONTH: month,
      MONTH_LABEL: span
        ? texts.dateRange(span.from, span.to)
        : `${texts.months[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`,
      MODE_MONTH: String(!span),
      MODE_RANGE: String(Boolean(span)),
      FROM: span?.from || '',
      TO: span?.to || '',
      SPLIT: split,
    };
    // {{t:signedInAs}} is a text in the page's language, {{USER}} a value; both escaped.
    const text = (key) => texts[key].replace(/\{(\w+)\}/g, (_, name) => values[name.toUpperCase()]);
    return pages[page].replace(/\{\{(t:)?(\w+)\}\}/g, (_, isText, key) =>
      escapeHtml(isText ? text(key) : (values[key] ?? '')),
    );
  }

  /** Deletes a text, saves its cleaned version, or records whether a reviewer has checked it. */
  async function changeText(action, id, value) {
    const texts = await table('texts');
    const params = { id: stringParam(id) };
    let sql = `DELETE FROM ${texts} WHERE id = @id`;
    if (action === 'clean') {
      sql = `UPDATE ${texts} SET text = @text WHERE id = @id`;
      params.text = stringParam(value);
    } else if (action === 'review') {
      sql = `UPDATE ${texts} SET reviewed = @reviewed WHERE id = @id`;
      params.reviewed = boolParam(value);
    }
    const { changed } = await query(sql, params);
    views.clear();
    return changed;
  }

  function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    const data = Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, {
      ...HEADERS,
      'Content-Type': type,
      'Content-Length': data.length,
      ...extra,
    });
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new QueryError(413, 'too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function post(req, res, reviewer, url) {
    // Only the page's own script sets this header; a form on another site cannot.
    if (req.headers['x-monitoring-page'] !== '1') {
      return send(res, 403, { error: 'forbidden' });
    }
    const match = ACTION.exec(url.pathname);
    if (!match || !ROW_ID.test(match[1])) {
      return send(res, 404, { error: 'not found' });
    }
    const [, id, action] = match;
    let text;
    let reviewed;
    try {
      const body = action === 'delete' ? {} : JSON.parse((await readBody(req)) || '{}');
      if (action === 'clean') {
        text =
          String(body?.text ?? '')
            .trim()
            .slice(0, MAX_TEXT_LENGTH) || REMOVED;
      } else if (action === 'review') {
        reviewed = body?.reviewed;
        if (typeof reviewed !== 'boolean') {
          return send(res, 400, { error: 'body' });
        }
      }
      if (!(await changeText(action, id, action === 'review' ? reviewed : text))) {
        return send(res, 404, { error: 'not found' });
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        return send(res, 400, { error: 'body' });
      }
      const status = error.status || 500;
      // 409: the row is still in the streaming buffer; the page asks to try again later.
      log(status === 409 ? 'WARNING' : 'ERROR', `feedback text ${action} failed`, {
        id,
        by: reviewer,
        detail: error.message,
      });
      return send(res, status, { error: error.message });
    }
    let message = action === 'delete' ? 'feedback text deleted' : 'feedback text cleaned';
    if (action === 'review') {
      message = reviewed ? 'feedback text reviewed' : 'feedback text review withdrawn';
    }
    log('NOTICE', message, { id, by: reviewer });
    return send(res, 200, { ok: true, text, reviewed });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === `${PREFIX}/healthz`) {
      return send(res, 200, 'ok', 'text/plain');
    }
    if (url.pathname === PREFIX) {
      res.writeHead(301, { Location: `${PREFIX}/` });
      return res.end();
    }
    // Set by IAP, e.g. "accounts.google.com:name@example.org".
    const reviewer = String(req.headers['x-goog-authenticated-user-email'] || '')
      .split(':')
      .pop();
    if (!reviewer) {
      return send(res, 403, { error: 'forbidden' });
    }
    if (req.method === 'POST') {
      return post(req, res, reviewer, url);
    }
    if (req.method !== 'GET') {
      return send(res, 405, { error: 'method' });
    }
    const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null;
    if (route === '/' || route === '/usage') {
      const asked = url.searchParams.get('m') || '';
      const span = askedInterval(url, berlinDay(now())) || null;
      let month = MONTH.test(asked) ? asked : berlinDay(now()).slice(0, 7);
      if (span) {
        month = span.to.slice(0, 7);
      }
      // The page asks for this month as soon as it has loaded; by then the queries are running.
      let loading;
      if (route === '/') {
        loading = Promise.all([
          feedbackMonths(),
          span ? cachedIntervalView(span) : cachedMonthView(...month.split('-').map(Number)),
        ]);
      } else {
        loading = span ? usage.interval(span.from, span.to) : usage.view(month);
      }
      loading.catch(() => {});
      const lang = language(req);
      const page = route === '/' ? 'feedback' : 'usage';
      const html = renderPage(page, reviewer, month, lang, span);
      return send(res, 200, html, 'text/html; charset=utf-8', {
        'Content-Language': lang,
      });
    }
    if (files[route]) {
      return send(res, 200, ...files[route]);
    }
    if (fonts[route]) {
      return send(res, 200, fonts[route], 'font/woff2', {
        'Cache-Control': 'private, max-age=86400',
      });
    }
    if (route === '/api/month') {
      const span = askedInterval(url, berlinDay(now()));
      const match = MONTH.exec(url.searchParams.get('m') || '');
      if (span === null || (!span && !match)) {
        return send(res, 400, { error: span === null ? 'interval' : 'month' });
      }
      try {
        const [list, view] = await Promise.all([
          feedbackMonths(),
          span ? cachedIntervalView(span) : cachedMonthView(Number(match[1]), Number(match[2])),
        ]);
        return send(res, 200, { ...view, ...list });
      } catch (error) {
        log('ERROR', 'feedback query failed', { detail: error.message });
        return send(res, error.status || 500, { error: error.message });
      }
    }
    if (route === '/api/usage') {
      const span = askedInterval(url, berlinDay(now()));
      const asked = url.searchParams.get('m') || '';
      if (span === null || (!span && !MONTH.test(asked))) {
        return send(res, 400, { error: span === null ? 'interval' : 'month' });
      }
      try {
        const view = span ? await usage.interval(span.from, span.to) : await usage.view(asked);
        return send(res, 200, { ...view, split });
      } catch (error) {
        log('ERROR', 'usage query failed', { detail: error.message });
        return send(res, error.status || 500, { error: error.message });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  /** The running month and every month before it, so the first visitor after a start does not wait. */
  const warm = () => usage.view(berlinDay(now()).slice(0, 7)).catch(() => {});

  return { handle, warm };
}

if (require.main === module) {
  const monitoring = createMonitoring();
  const port = Number(process.env.PORT || 8080);
  http
    .createServer((req, res) => {
      monitoring.handle(req, res).catch((error) => {
        log('ERROR', 'monitoring request failed', { detail: error.message });
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
    })
    .listen(port, () => {
      log('INFO', 'monitoring page listening', { port });
      monitoring.warm();
    });
}

module.exports = { createMonitoring };
