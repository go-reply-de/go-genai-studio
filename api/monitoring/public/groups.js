'use strict';
/* global MonitoringShell */

/**
 * "Wer nutzt wie viel?" on the Nutzung tab: the weekly usage groups from api/groups, one week at a
 * time. The arrows step through the weeks of the tab's month or interval (a week counts where its
 * Thursday falls), which opens on its newest week: the running one, or the last of a past month.
 */
const MonitoringGroups = (() => {
  /** groups.js keeps a week with fewer active users as one row. */
  const MIN_ACTIVE = 10;
  const DAY_MS = 864e5;
  /** The job rewrites the running week every hour; the server keeps an answer five minutes. */
  const REFRESH_MS = 5 * 60 * 1000;

  const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
  const pct = (T, value) =>
    new Intl.NumberFormat(T.locale, { style: 'percent', maximumFractionDigits: 0 }).format(
      value / 100,
    );
  const usersOf = (groups) => groups.reduce((n, g) => n + g.users, 0);
  const thursdayOf = (monday) =>
    new Date(Date.parse(`${monday}T00:00:00Z`) + 3 * DAY_MS).toISOString().slice(0, 10);
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  /** The stored weeks of the days `from` to `to` (YYYY-MM-DD): those whose Thursday falls in them. */
  const weeksIn = (weeks, from, to) =>
    weeks.filter((w) => thursdayOf(w.week) >= from && thursdayOf(w.week) <= to);

  /** Where a list of weeks opens: its newest week, which is the running one while it lasts. */
  function openingWeek(list) {
    if (!list.length) {
      return { index: -1, scope: 'none' };
    }
    const index = list.length - 1;
    return { index, scope: list[index].running ? 'running' : 'full' };
  }

  /** A merged group is named after the group it reaches into: "Regelmäßig oder mehr". */
  function groupName(g, T) {
    if (g.top === g.bottom) {
      return T.groupNames[g.top];
    }
    if (g.top === 'power' && g.bottom === 'occasional') {
      return T.groupAll;
    }
    return g.top === 'power'
      ? fill(T.groupOrMore, { name: T.groupNames[g.bottom] })
      : fill(T.groupOrLess, { name: T.groupNames[g.top] });
  }

  const groupRange = (g, T) =>
    fill(T.groupRange, { range: g.max === null ? `${g.min}+` : `${g.min}–${g.max}` });

  /** The top group's people and shares as one sentence, the figures in bold. */
  function headline(groups, T) {
    const top = groups[0];
    const who =
      top.top === 'power' && top.bottom === 'power'
        ? `<b>${fill(T.groupsWhoPower, { n: top.users })}</b>`
        : fill(T.groupsWhoRange, {
            users: `<b>${fill(T.groupsUsers, { n: top.users })}</b>`,
            range:
              top.max === null
                ? fill(T.groupsAtLeast, { min: top.min })
                : fill(T.groupsFromTo, { min: top.min, max: top.max }),
          });
    return fill(T.groupsLead, {
      who,
      share: pct(T, Math.round((100 * top.users) / usersOf(groups))),
      conversations: `<b>${pct(T, top.conversations)}</b>`,
      tokens: `<b>${pct(T, top.tokens)}</b>`,
    });
  }

  /** Groups, or why a week stayed one row: too few people, or no split with 5 in each group. */
  function statusOf(groups) {
    if (groups.length > 1) {
      return 'groups';
    }
    return usersOf(groups) < MIN_ACTIVE ? 'tooFew' : 'oneGroup';
  }

  const state = {
    weeks: null,
    loaded: 0,
    loading: null,
    failed: false,
    key: '',
    chosen: null,
    list: [],
    index: -1,
  };

  function load() {
    state.loading ??= fetch('api/groups', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        state.weeks = data.weeks;
        state.loaded = Date.now();
        state.failed = false;
      })
      // A failed refresh keeps the weeks already shown.
      .catch(() => {
        state.failed = !state.weeks;
      })
      .finally(() => {
        state.loading = null;
      });
    return state.loading;
  }

  const note = (text) => `<section class="panel groups-note"><p>${esc(text)}</p></section>`;

  function table(groups, T) {
    const intact = (g) => g.top === 'power' && g.bottom === 'power';
    const bar = (value, cls, label) =>
      `<td data-label="${esc(label)}"><span class="cellbar"><span class="track ${cls}">` +
      `<i style="width:${Number(value)}%"></i></span><span>${esc(pct(T, value))}</span></span></td>`;
    const rows = groups
      .map((g) => {
        // Only an intact power-user group stands out; a merged week highlights no row.
        const cls = intact(g) ? 'g0' : 'g1';
        return (
          `<tr><td><b>${esc(groupName(g, T))}</b><small>${esc(groupRange(g, T))}</small></td>` +
          `<td data-unit="${esc(T.groupUsersCol)}">${Number(g.users)}</td>` +
          bar(g.conversations, cls, T.groupConversationsCol) +
          bar(g.tokens, cls, T.groupTokensCol) +
          '</tr>'
        );
      })
      .join('');
    return (
      '<section class="panel groups-panel" aria-labelledby="groups-panel-title">' +
      `<div class="panel-head"><h3 id="groups-panel-title">${esc(T.groupsPanel)}</h3></div>` +
      `<p class="groups-lead">${headline(groups, T)}</p>` +
      '<div class="scroll-x"><table class="tbl groups-tbl"><thead><tr>' +
      [T.groupCol, T.groupUsersCol, T.groupConversationsCol, T.groupTokensCol]
        .map((name) => `<th scope="col">${esc(name)}</th>`)
        .join('') +
      `</tr></thead><tbody>${rows}</tbody></table></div></section>`
    );
  }

  function render() {
    const { T, t, $, weekSpan, shiftDay, calendarWeek, spanOf, isoDate, daysIn } = MonitoringShell;
    const body = $('groups-body');
    const line = $('groups-week');
    const prev = $('groups-prev');
    const next = $('groups-next');
    prev.disabled = true;
    next.disabled = true;
    state.list = [];
    if (!state.weeks || !state.weeks.length) {
      line.textContent = state.weeks || state.failed ? '' : T.loading;
      if (state.failed || state.weeks) {
        body.innerHTML = note(state.failed ? T.groupsFailed : T.groupsNone);
      }
      return;
    }
    // Only the weeks of the tab's month or interval; another month is chosen at the top.
    const span = spanOf(state.key);
    const [y, m] = state.key.split('-').map(Number);
    const [from, to] = span
      ? [span.from, span.to]
      : [isoDate(y, m, 1), isoDate(y, m, daysIn(y, m))];
    const where = span ? T.groupsPeriod : T.months[m - 1];
    const list = weeksIn(state.weeks, from, to);
    state.list = list;
    if (!list.length) {
      line.textContent = '';
      body.innerHTML = note(fill(T.groupsNoneIn, { month: where }));
      return;
    }
    let index = state.chosen ? list.findIndex((w) => w.week === state.chosen) : -1;
    let scope = '';
    if (index < 0) {
      const opening = openingWeek(list);
      index = opening.index;
      // The running week says so itself ("läuft"); a past month names its last week.
      if (opening.scope === 'full') {
        scope = fill(T.groupsScopeFull, { month: where });
      }
    }
    const w = list[index];
    const n = usersOf(w.groups);
    const text = fill(w.running ? T.groupsWeekRunning : T.groupsWeek, {
      kw: t('kw', { n: calendarWeek(w.week) }),
      span: weekSpan({ from: w.week, to: shiftDay(w.week, 6) }),
      n,
    });
    line.textContent = scope ? `${scope}: ${text}` : text;
    const status = statusOf(w.groups);
    if (status === 'groups') {
      body.innerHTML = table(w.groups, T);
    } else {
      body.innerHTML = note(fill(status === 'tooFew' ? T.groupsTooFew : T.groupsOneGroup, { n }));
    }
    prev.disabled = index === 0;
    next.disabled = index === list.length - 1;
    state.index = index;
  }

  function step(by) {
    const target = state.list[state.index + by];
    if (target) {
      state.chosen = target.week;
      render();
    }
  }

  let wired = false;

  /** Shows the week for the tab's month or interval; a week stepped to stays while it is shown. */
  async function show(key) {
    if (!wired) {
      wired = true;
      MonitoringShell.$('groups-prev').addEventListener('click', () => step(-1));
      MonitoringShell.$('groups-next').addEventListener('click', () => step(1));
    }
    if (key !== state.key) {
      state.key = key;
      state.chosen = null;
    }
    if (!state.weeks || Date.now() - state.loaded > REFRESH_MS) {
      render();
      await load();
    }
    if (key === state.key) {
      render();
    }
  }

  return { weeksIn, openingWeek, groupName, groupRange, headline, statusOf, show };
})();

if (typeof module === 'object') {
  module.exports = MonitoringGroups;
}
