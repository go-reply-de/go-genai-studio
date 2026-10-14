/**
 * Feedback review page: the counts and free texts of the BigQuery dataset in FEEDBACK_DATASET.
 *
 * Runs from the API image under its own Kubernetes service account, which may read the
 * feedback tables and clean texts; the API itself may only add rows. Only the load balancer
 * reaches this pod (see k8s/feedback-review.yaml), so the reviewer's e-mail in IAP's header can
 * be trusted. Deletes, cleans and reviews are logged with that e-mail and the row id, never with
 * the text, and filtering happens in the browser, so no search term reaches BigQuery's audit log.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const TEXTS = require('./public/i18n');

const PREFIX = '/feedback';
const MAX_TEXT_LENGTH = 500;
const MAX_BODY = 8192;
const REMOVED = '[entfernt]';
const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
/** Private Google Access in the cluster serves *.googleapis.com, not the regional rep names. */
const BIGQUERY = 'https://bigquery.googleapis.com/bigquery/v2';
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
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
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
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

class QueryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function log(severity, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ severity, message, ...fields })}\n`);
}

const pad = (n) => String(n).padStart(2, '0');
const day = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dateParam = (value) => ({ type: 'DATE', value });
const stringParam = (value) => ({ type: 'STRING', value });
const boolParam = (value) => ({ type: 'BOOL', value: String(value) });
const berlinDay = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(date);
const LANG_COOKIE = /(?:^|;\s*)feedback-lang=(de|en)(?:;|$)/;

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
function createReview({
  env = process.env,
  fetchFn = fetch,
  now = () => new Date(),
  staticDir = path.join(__dirname, 'public'),
  fontDirs = FONT_DIRS,
} = {}) {
  const dataset = env.FEEDBACK_DATASET?.trim() || 'feedback';
  const template = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
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
  let project = '';
  let token = { value: '', expires: 0 };
  let refreshing = null;
  let months = { list: null, expires: 0 };
  const views = new Map();
  const at = () => now().getTime();

  async function metadata(p) {
    const res = await fetchFn(`${METADATA}/${p}`, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) {
      throw new QueryError(502, `metadata HTTP ${res.status}`);
    }
    return res;
  }

  async function refresh() {
    if (!project) {
      project = (await (await metadata('project/project-id')).text()).trim();
    }
    const data = await (await metadata('instance/service-accounts/default/token')).json();
    token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  }

  /** Queries run in parallel, so they share one token request. */
  async function credentials() {
    if (!project || Date.now() > token.expires - 60000) {
      refreshing ??= refresh().finally(() => {
        refreshing = null;
      });
      await refreshing;
    }
    return { project, token: token.value };
  }

  async function call(url, body) {
    const { token: bearer } = await credentials();
    const res = await fetchFn(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      return res.json();
    }
    const detail = await res.text();
    // DML cannot touch rows still in the streaming buffer, up to about 90 minutes after they arrive.
    if (detail.includes('streaming buffer')) {
      throw new QueryError(409, 'streaming buffer');
    }
    throw new QueryError(502, `BigQuery HTTP ${res.status}`);
  }

  /** Rows as arrays of strings, and the number of rows a DML statement changed. */
  async function query(sql, params) {
    const { project: id } = await credentials();
    const base = `${BIGQUERY}/projects/${id}/queries`;
    let data = await call(base, {
      query: sql,
      useLegacySql: false,
      // Small queries then run without a job: about 0.3 s instead of 1 s each in sov-dev.
      jobCreationMode: 'JOB_CREATION_OPTIONAL',
      timeoutMs: 60000,
      parameterMode: 'NAMED',
      queryParameters: Object.entries(params).map(([name, { type, value }]) => ({
        name,
        parameterType: { type },
        parameterValue: { value },
      })),
    });
    if (!data.jobComplete) {
      throw new QueryError(504, 'query did not finish in time');
    }
    const rows = (data.rows || []).map((row) => row.f.map((cell) => cell.v));
    const { jobId, location } = data.jobReference || {};
    while (data.pageToken) {
      const page = new URLSearchParams({ location, pageToken: data.pageToken });
      data = await call(`${base}/${jobId}?${page}`);
      rows.push(...(data.rows || []).map((row) => row.f.map((cell) => cell.v)));
    }
    return { rows, changed: Number(data.numDmlAffectedRows || 0) };
  }

  const table = async (name) => `\`${(await credentials()).project}.${dataset}.${name}\``;

  /**
   * A month's counts, compared with the same days of the month before while it is still
   * running (1–12 October against 1–12 September), and its texts.
   */
  async function monthView(y, m) {
    const first = day(y, m, 1);
    const last = day(y, m, daysIn(y, m));
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    const today = berlinDay(now());
    const running = today.slice(0, 7) === `${y}-${pad(m)}`;
    const until = running ? Number(today.slice(8)) : daysIn(y, m);
    const previousLast = day(py, pm, running ? Math.min(until, daysIn(py, pm)) : daysIn(py, pm));
    const [{ rows: counts }, { rows }] = await Promise.all([
      query(
        `SELECT date, rating, reason, SUM(ratings), SUM(texts) FROM ${await table('counts')} ` +
          'WHERE date BETWEEN @first AND @last GROUP BY date, rating, reason',
        { first: dateParam(day(py, pm, 1)), last: dateParam(last) },
      ),
      query(
        `SELECT id, date, rating, reason, text, reviewed FROM ${await table('texts')} ` +
          'WHERE date BETWEEN @first AND @last ORDER BY date DESC, id',
        { first: dateParam(first), last: dateParam(last) },
      ),
    ]);
    const current = { rated: 0, up: 0, down: 0, texts: 0 };
    const previous = {
      from: day(py, pm, 1),
      to: previousLast,
      rated: 0,
      up: 0,
      down: 0,
      texts: 0,
    };
    const days = Array.from({ length: daysIn(y, m) }, () => [0, 0]);
    const reasons = { thumbsDown: {}, thumbsUp: {} };
    for (const [date, rating, reason, ratingsValue, textsValue] of counts) {
      const ratings = Number(ratingsValue);
      const inMonth = date >= first;
      if (!inMonth && date > previousLast) {
        continue;
      }
      const totals = inMonth ? current : previous;
      totals.texts += Number(textsValue);
      if (!(rating in reasons)) {
        continue;
      }
      const up = rating === 'thumbsUp';
      totals[up ? 'up' : 'down'] += ratings;
      totals.rated += ratings;
      if (inMonth) {
        days[Number(date.slice(8)) - 1][up ? 0 : 1] += ratings;
        reasons[rating][reason] = (reasons[rating][reason] || 0) + ratings;
      }
    }
    const texts = rows.map(([id, date, rating, reason, text, reviewed]) => ({
      id,
      date,
      rating,
      reason,
      text,
      reviewed: reviewed === 'true',
    }));
    return {
      month: `${y}-${pad(m)}`,
      period: { from: first, to: day(y, m, until), running },
      current,
      previous,
      days,
      reasons,
      texts,
    };
  }

  /**
   * A month's view, shared by requests that ask while it loads. A text that changes clears all
   * of them, so a result still loading then is not kept.
   */
  async function cachedMonthView(y, m) {
    const key = `${y}-${pad(m)}`;
    const hit = views.get(key);
    if (hit && at() < hit.expires) {
      return hit.view;
    }
    const entry = { view: monthView(y, m), expires: Infinity };
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

  /** Months with feedback and their ratings, newest first; the running month is always one. */
  async function feedbackMonths() {
    if (at() >= months.expires) {
      const entry = {
        list: table('counts')
          .then((counts) =>
            query(
              `SELECT FORMAT_DATE('%Y-%m', date) AS month, ` +
                // Named apart from the column: HAVING would otherwise read SUM(ratings) as this sum.
                "SUM(IF(rating IN ('thumbsUp', 'thumbsDown'), ratings, 0)) AS rated " +
                `FROM ${counts} GROUP BY month ` +
                'HAVING SUM(ratings) != 0 OR SUM(texts) != 0 ORDER BY month DESC',
              {},
            ),
          )
          .then(({ rows }) => rows.map(([month, ratings]) => [month, Number(ratings)])),
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

  /** The page with its header written in, so it is complete before any data arrives. */
  function renderPage(reviewer, month, lang) {
    const texts = TEXTS[lang];
    const app = env.APP_TITLE?.trim() || 'Feedback';
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
      MONTH_LABEL: `${texts.months[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`,
    };
    // {{t:signedInAs}} is a text in the page's language, {{USER}} a value; both escaped.
    const text = (key) => texts[key].replace(/\{(\w+)\}/g, (_, name) => values[name.toUpperCase()]);
    return template.replace(/\{\{(t:)?(\w+)\}\}/g, (_, isText, key) =>
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
    if (req.headers['x-feedback-review'] !== '1') {
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
    if (route === '/') {
      const asked = url.searchParams.get('m') || '';
      const month = MONTH.test(asked) ? asked : berlinDay(now()).slice(0, 7);
      // The page asks for this month as soon as it has loaded; by then the queries are running.
      Promise.all([feedbackMonths(), cachedMonthView(...month.split('-').map(Number))]).catch(
        () => {},
      );
      const lang = language(req);
      return send(res, 200, renderPage(reviewer, month, lang), 'text/html; charset=utf-8', {
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
      const match = MONTH.exec(url.searchParams.get('m') || '');
      if (!match) {
        return send(res, 400, { error: 'month' });
      }
      try {
        const [list, view] = await Promise.all([
          feedbackMonths(),
          cachedMonthView(Number(match[1]), Number(match[2])),
        ]);
        return send(res, 200, { ...view, ...list });
      } catch (error) {
        log('ERROR', 'feedback review query failed', { detail: error.message });
        return send(res, error.status || 500, { error: error.message });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  return { handle };
}

if (require.main === module) {
  const review = createReview();
  const port = Number(process.env.PORT || 8080);
  http
    .createServer((req, res) => {
      review.handle(req, res).catch((error) => {
        log('ERROR', 'feedback review request failed', { detail: error.message });
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
    })
    .listen(port, () => log('INFO', 'feedback review listening', { port }));
}

module.exports = { createReview };
