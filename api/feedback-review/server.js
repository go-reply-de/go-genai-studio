/**
 * Feedback review page: the counts and free texts of the BigQuery dataset in FEEDBACK_DATASET.
 *
 * Runs from the API image under its own Kubernetes service account, which may read the
 * feedback tables and clean texts; the API itself may only add rows. Only the load balancer
 * reaches this pod (see k8s/feedback-review.yaml), so the reviewer's e-mail in IAP's header can
 * be trusted. Deletes and cleans are logged with that e-mail and the row id, never with the
 * text, and filtering happens in the browser, so no search term reaches BigQuery's audit log.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const PREFIX = '/feedback';
const MAX_TEXT_LENGTH = 500;
const MAX_BODY = 8192;
const REMOVED = '[entfernt]';
const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
/** Private Google Access in the cluster serves *.googleapis.com, not the regional rep names. */
const BIGQUERY = 'https://bigquery.googleapis.com/bigquery/v2';
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ACTION = new RegExp(`^${PREFIX}/api/texts/([^/]+)/(delete|clean)$`);
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
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
/** LibreChat's own Inter, from the client build in the image or its sources in a checkout. */
const FONTS = ['Inter-Regular.woff2', 'Inter-SemiBold.woff2', 'Inter-Bold.woff2'];
const FONT_DIRS = [
  path.join(__dirname, '..', '..', 'client', 'dist', 'fonts'),
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
const berlinDay = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(date);

/** The page and its API; `fetchFn`, `env` and the clock are swapped in tests. */
function createReview({
  env = process.env,
  fetchFn = fetch,
  now = () => new Date(),
  staticDir = path.join(__dirname, 'public'),
  fontDirs = FONT_DIRS,
} = {}) {
  const dataset = env.FEEDBACK_DATASET?.trim() || 'feedback';
  const files = Object.fromEntries(
    Object.entries(STATIC).map(([route, [name, type]]) => [
      route,
      [fs.readFileSync(path.join(staticDir, name)), type],
    ]),
  );
  const fontDir = fontDirs.find((dir) => fs.existsSync(path.join(dir, FONTS[0])));
  const fonts = Object.fromEntries(
    fontDir
      ? FONTS.map((name) => [`/fonts/${name}`, fs.readFileSync(path.join(fontDir, name))])
      : [],
  );
  let project = '';
  let token = { value: '', expires: 0 };

  async function metadata(p) {
    const res = await fetchFn(`${METADATA}/${p}`, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) {
      throw new QueryError(502, `metadata HTTP ${res.status}`);
    }
    return res;
  }

  async function credentials() {
    if (!project) {
      project = (await (await metadata('project/project-id')).text()).trim();
    }
    if (Date.now() > token.expires - 60000) {
      const data = await (await metadata('instance/service-accounts/default/token')).json();
      token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
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
    const { rows: counts } = await query(
      `SELECT date, rating, reason, SUM(ratings), SUM(texts) FROM ${await table('counts')} ` +
        'WHERE date BETWEEN @first AND @last GROUP BY date, rating, reason',
      { first: dateParam(day(py, pm, 1)), last: dateParam(last) },
    );
    const current = { rated: 0, up: 0, down: 0, texts: 0 };
    const previous = {
      label: MONTHS[pm - 1],
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
    const { rows } = await query(
      `SELECT id, date, rating, reason, text FROM ${await table('texts')} ` +
        'WHERE date BETWEEN @first AND @last ORDER BY date DESC, id',
      { first: dateParam(first), last: dateParam(last) },
    );
    const texts = rows.map(([id, date, rating, reason, text]) => ({
      id,
      date,
      rating,
      reason,
      text,
    }));
    return {
      application: env.APP_TITLE || '',
      environment: env.ENVIRONMENT || '',
      month: `${y}-${pad(m)}`,
      label: `${MONTHS[m - 1]} ${y}`,
      period: { from: first, to: day(y, m, until), running },
      current,
      previous,
      days,
      reasons,
      texts,
    };
  }

  async function changeText(action, id, text) {
    const texts = await table('texts');
    const { changed } =
      action === 'delete'
        ? await query(`DELETE FROM ${texts} WHERE id = @id`, { id: stringParam(id) })
        : await query(`UPDATE ${texts} SET text = @text WHERE id = @id`, {
            id: stringParam(id),
            text: stringParam(text),
          });
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
    try {
      if (action === 'clean') {
        const body = JSON.parse((await readBody(req)) || '{}');
        text =
          String(body.text ?? '')
            .trim()
            .slice(0, MAX_TEXT_LENGTH) || REMOVED;
      }
      if (!(await changeText(action, id, text))) {
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
    log('NOTICE', action === 'delete' ? 'feedback text deleted' : 'feedback text cleaned', {
      id,
      by: reviewer,
    });
    return send(res, 200, { ok: true, text });
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
        return send(res, 200, {
          ...(await monthView(Number(match[1]), Number(match[2]))),
          user: reviewer,
        });
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
