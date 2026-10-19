/**
 * The feedback store's figures for a month or an interval, as the Feedback tab and the monitoring
 * report show them: ratings, reasons and comments per Berlin day.
 */
const DAY_MS = 24 * 3600e3;

const pad = (n) => String(n).padStart(2, '0');
const day = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dateParam = (value) => ({ type: 'DATE', value });
const berlinDay = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(date);

const textRows = (rows) =>
  rows.map(([id, date, rating, reason, text, reviewed]) => ({
    id,
    date,
    rating,
    reason,
    text,
    reviewed: reviewed === 'true',
  }));

/** `query` and `table` come from google.js; the clock is swapped in tests. */
function createFeedback({ query, table, now = () => new Date() }) {
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
    const texts = textRows(rows);
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

  /** The counts and texts of the days from `from` to `to`, up to today; nothing to compare with. */
  async function intervalView(from, to) {
    const today = berlinDay(now());
    const last = to < today ? to : today;
    const params = { first: dateParam(from), last: dateParam(last) };
    const [{ rows: counts }, { rows }] = await Promise.all([
      query(
        `SELECT date, rating, reason, SUM(ratings), SUM(texts) FROM ${await table('counts')} ` +
          'WHERE date BETWEEN @first AND @last GROUP BY date, rating, reason',
        params,
      ),
      query(
        `SELECT id, date, rating, reason, text, reviewed FROM ${await table('texts')} ` +
          'WHERE date BETWEEN @first AND @last ORDER BY date DESC, id',
        params,
      ),
    ]);
    const current = { rated: 0, up: 0, down: 0, texts: 0 };
    const index = (date) => Math.round((Date.parse(date) - Date.parse(from)) / DAY_MS);
    const days = Array.from({ length: index(last) + 1 }, () => [0, 0]);
    const reasons = { thumbsDown: {}, thumbsUp: {} };
    for (const [date, rating, reason, ratingsValue, textsValue] of counts) {
      const ratings = Number(ratingsValue);
      current.texts += Number(textsValue);
      if (rating in reasons) {
        const up = rating === 'thumbsUp';
        current[up ? 'up' : 'down'] += ratings;
        current.rated += ratings;
        days[index(date)][up ? 0 : 1] += ratings;
        reasons[rating][reason] = (reasons[rating][reason] || 0) + ratings;
      }
    }
    return {
      period: { from, to: last, running: last === today },
      current,
      previous: null,
      days,
      reasons,
      texts: textRows(rows),
    };
  }

  /** Months with feedback and their ratings, newest first. */
  async function ratedMonths() {
    const { rows } = await query(
      `SELECT FORMAT_DATE('%Y-%m', date) AS month, ` +
        // Named apart from the column: HAVING would otherwise read SUM(ratings) as this sum.
        "SUM(IF(rating IN ('thumbsUp', 'thumbsDown'), ratings, 0)) AS rated " +
        `FROM ${await table('counts')} GROUP BY month ` +
        'HAVING SUM(ratings) != 0 OR SUM(texts) != 0 ORDER BY month DESC',
      {},
    );
    return rows.map(([month, ratings]) => [month, Number(ratings)]);
  }

  return { monthView, intervalView, ratedMonths };
}

module.exports = { createFeedback };
