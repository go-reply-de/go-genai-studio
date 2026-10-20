'use strict';
/* global MonitoringTexts */

/** Shared by both tabs: their texts, the language and theme switches and the month header. */
// eslint-disable-next-line no-unused-vars -- app.js and usage.js read it.
const MonitoringShell = (() => {
  // The page's language, which the server writes into <html lang> from the reviewer's choice.
  const T = MonitoringTexts[document.documentElement.lang === 'en' ? 'en' : 'de'];
  const t = (key, values = {}) => T[key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
  const $ = (id) => document.getElementById(id);
  const THEME_KEY = 'monitoring-theme';
  const LANG_COOKIE = 'monitoring-lang';
  const monthLabel = (month) => `${T.months[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
  const berlinMonth = () =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
  const berlinDay = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
  const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  /** A calendar date as YYYY-MM-DD; days past a month's end roll over. */
  const isoDate = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  const shiftDay = (date, days) => {
    const [y, m, d] = date.split('-').map(Number);
    return isoDate(y, m, d + days);
  };
  /** The same day a month earlier or later, or that month's last day. */
  const shiftMonth = (date, months) => {
    const [y, m, d] = date.split('-').map(Number);
    const first = isoDate(y, m + months, 1);
    const [fy, fm] = first.split('-').map(Number);
    return isoDate(fy, fm, Math.min(d, daysIn(fy, fm)));
  };
  const dayOf = (iso) => Number(iso.slice(8, 10));
  const monthOf = (iso) => Number(iso.slice(5, 7));
  /** A week's dates, with one month name unless the week spans two. */
  const weekSpan = ({ from, to }) =>
    monthOf(from) === monthOf(to)
      ? `${T.daySpan(dayOf(from), dayOf(to))} ${T.short[monthOf(to) - 1]}`
      : `${T.shortDate(dayOf(from), monthOf(from))} – ${T.shortDate(dayOf(to), monthOf(to))}`;
  const mondayOf = (date) => shiftDay(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
  /** The calendar week of a Monday, counted by its Thursday as ISO 8601 does. */
  const calendarWeek = (monday) => {
    const thursday = shiftDay(monday, 3);
    const start = Date.parse(`${thursday.slice(0, 4)}-01-01`);
    return Math.floor((Date.parse(thursday) - start) / 864e5 / 7) + 1;
  };
  /** Both tabs chart an interval per calendar week once it is longer than this. */
  const MAX_DAY_COLUMNS = 62;
  /**
   * An interval's days as chart columns: each day, or Mondays to Sundays cut to the interval
   * once it is too long, with the indexes of its days. `axis` labels every few columns.
   */
  function columnsOf(from, count) {
    const dates = Array.from({ length: count }, (_, i) => shiftDay(from, i));
    if (count <= MAX_DAY_COLUMNS) {
      const every = Math.ceil(count / 8);
      return dates.map((date, i) => ({
        days: [i],
        label: T.shortDate(dayOf(date), monthOf(date)),
        axis: i % every === 0 ? T.dayMonth(dayOf(date), monthOf(date)) : '',
      }));
    }
    const weeks = [];
    dates.forEach((date, i) => {
      const monday = mondayOf(date);
      if (weeks.at(-1)?.monday !== monday) {
        weeks.push({ monday, days: [] });
      }
      weeks.at(-1).days.push(i);
    });
    const every = Math.ceil(weeks.length / 8);
    const list = weeks.map(({ monday, days }, i) => {
      const kw = t('kw', { n: calendarWeek(monday) });
      // A week cut by the interval, or not over yet, names the days it holds.
      const part = days.length < 7;
      const span = weekSpan({
        from: part ? dates[days[0]] : monday,
        to: part ? dates[days.at(-1)] : shiftDay(monday, 6),
      });
      return {
        days,
        monday,
        part,
        label: part ? t('weekPart', { kw, span }) : `${kw}, ${span}`,
        axis: i % every === 0 ? kw : '',
      };
    });
    list.weekly = true;
    return list;
  }
  const spanKey = ({ from, to }) => `${from}_${to}`;
  const spanOf = (key) =>
    key.includes('_') ? { from: key.slice(0, 10), to: key.slice(11) } : null;
  /** The address of a month or an interval, which both tabs also carry to each other. */
  const query = (key) => {
    const span = spanOf(key);
    return span ? `?from=${span.from}&to=${span.to}` : `?m=${key}`;
  };
  const label = (key) => {
    const span = spanOf(key);
    return span ? T.dateRange(span.from, span.to) : monthLabel(key);
  };

  /** Shows a month or an interval in the address and in both tab links. */
  function address(key) {
    history.replaceState(null, '', query(key));
    document.querySelectorAll('.tabs a').forEach((a) => {
      a.search = query(key);
    });
  }

  function storage(read) {
    try {
      return read(localStorage);
    } catch {
      return null;
    }
  }

  const GRID_KEYS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };

  /**
   * The month header: ‹ › step through the months, the title opens one year's months as a grid.
   * `months()` lists the months that can be opened, newest first; `describe(month)` gives such a
   * month's count and spoken detail; `none` speaks for a month without data, `earlier` and
   * `later` for a step that leads nowhere; `onPick` opens a month.
   */
  function monthPicker({ months, current, describe, none, earlier, later, onPick }) {
    let year = 0;

    function renderGrid() {
      const list = months();
      const focused = document.activeElement?.closest?.('#month-grid button')?.dataset.month;
      const newest = list[0] || current();
      const years = list.map((month) => Number(month.slice(0, 4)));
      $('year-label').textContent = year;
      $('year-prev').disabled = year <= Math.min(...years);
      $('year-next').disabled = year >= Math.max(...years);
      const cells = T.months.map((name, i) => {
        const month = `${year}-${String(i + 1).padStart(2, '0')}`;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.tabIndex = -1;
        cell.dataset.month = month;
        cell.disabled = !list.includes(month);
        let count = month > newest ? '' : '–';
        let detail = month > newest ? t('notStarted') : none;
        if (!cell.disabled) {
          ({ count, detail } = describe(month));
          if (month === newest) {
            detail += `, ${t('runningTag')}`;
          }
        }
        cell.innerHTML = `<span>${T.short[i]}</span><small>${count}</small>`;
        cell.setAttribute('aria-label', `${name} ${year}, ${detail}`);
        cell.classList.toggle('running', month === newest);
        if (month === current()) {
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

    function open() {
      year = Number(current().slice(0, 4));
      $('month-pop').hidden = false;
      $('month-button').setAttribute('aria-expanded', 'true');
      renderGrid();
      $('month-grid').querySelector('[tabindex="0"]')?.focus();
    }

    function close(restoreFocus) {
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
      year += step;
      renderGrid();
      // A year button that has just been disabled drops focus; keep it inside the picker.
      if (document.activeElement === document.body || document.activeElement?.disabled) {
        $('month-grid').querySelector('[tabindex="0"]')?.focus();
      }
    }

    /** Arrow keys move between months that can be opened, Home and End jump to the first and last. */
    function moveInGrid(event) {
      const cells = [...$('month-grid').children];
      const enabled = cells.filter((c) => !c.disabled);
      let to;
      if (event.key in GRID_KEYS) {
        const step = GRID_KEYS[event.key];
        let i = cells.indexOf(document.activeElement) + step;
        while (i >= 0 && i < cells.length && cells[i].disabled) {
          i += step;
        }
        to = cells[i];
      } else if (event.key === 'Home' || event.key === 'End') {
        to = event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1];
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

    function setStep(button, month, label, nothing) {
      button.disabled = !month;
      button.dataset.month = month || '';
      button.setAttribute('aria-label', month ? `${label}: ${monthLabel(month)}` : nothing);
      button.title = month ? monthLabel(month) : nothing;
    }

    function renderNav(key) {
      const span = spanOf(key);
      document.querySelector('.month-nav').dataset.span = String(Boolean(span));
      document.querySelectorAll('[data-mode]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.mode === (span ? 'range' : 'month')));
      });
      $('month-button').setAttribute('aria-controls', span ? 'range-pop' : 'month-pop');
      $('month-hint').textContent = span ? t('chooseRange') : t('chooseMonth');
      $('month-title').textContent = label(key);
      if (span) {
        $('month-button').dataset.month = span.to.slice(0, 7);
        return;
      }
      const month = key;
      const list = months();
      $('month-button').dataset.month = month;
      const i = list.indexOf(month);
      setStep($('prev'), i < 0 ? '' : list[i + 1], t('prevMonth'), earlier);
      setStep($('next'), i > 0 ? list[i - 1] : '', t('nextMonth'), later);
    }

    // In an interval the title opens the interval picker instead.
    $('month-button').addEventListener('click', () => {
      if (!spanOf(current())) {
        if ($('month-pop').hidden) {
          open();
        } else {
          close(true);
        }
      }
    });
    $('month-grid').addEventListener('click', (event) => {
      const cell = event.target.closest('button');
      if (cell && !cell.disabled) {
        close(true);
        onPick(cell.dataset.month);
      }
    });
    $('month-grid').addEventListener('keydown', moveInGrid);
    $('year-prev').addEventListener('click', () => changeYear(-1));
    $('year-next').addEventListener('click', () => changeYear(1));
    document.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('#month-pop, #month-button')) {
        close(false);
      }
    });
    $('month-pop').addEventListener('focusout', (event) => {
      if (event.relatedTarget && !event.relatedTarget.closest('#month-pop, #month-button')) {
        close(false);
      }
    });
    $('prev').addEventListener('click', () => onPick($('prev').dataset.month));
    $('next').addEventListener('click', () => onPick($('next').dataset.month));

    return {
      renderNav,
      close,
      isOpen: () => !$('month-pop').hidden,
      /** New months or counts show at once in an open grid. */
      refresh: () => {
        if (!$('month-pop').hidden) {
          renderGrid();
        }
      },
    };
  }

  const DAY_KEYS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

  /**
   * The interval picker: Von and Bis, a month of days with the days between them marked, and
   * quick choices. `earliest()` is the first day that can be picked, today the last; `start()`
   * gives the interval it opens with; `onApply` opens an interval.
   */
  function rangePicker({ current, earliest, start, onApply }) {
    let draft = null;
    let end = 'from';
    let shown = '';
    let focus = '';
    const dateText = (date) =>
      new Date(`${date}T00:00:00Z`).toLocaleDateString(T.locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'UTC',
      });
    const clamp = (date) => {
      const [min, max] = [earliest(), berlinDay()];
      if (date < min) {
        return min;
      }
      return date > max ? max : date;
    };
    $('cal-head').innerHTML = T.weekdays.map((d) => `<span>${d}</span>`).join('');

    function render() {
      for (const which of ['from', 'to']) {
        const button = $(`range-${which}`);
        button.setAttribute('aria-pressed', String(end === which));
        button.querySelector('span').textContent = dateText(draft[which]);
      }
      const [y, m] = shown.split('-').map(Number);
      const [min, today] = [earliest(), berlinDay()];
      $('cal-label').textContent = `${T.months[m - 1]} ${y}`;
      $('cal-prev').disabled = shown <= min.slice(0, 7);
      $('cal-next').disabled = shown >= today.slice(0, 7);
      // Monday first, as the weeks are counted.
      const blanks = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
      const cells = Array.from({ length: blanks }, () => document.createElement('span'));
      for (let d = 1; d <= daysIn(y, m); d++) {
        const date = isoDate(y, m, d);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.dataset.date = date;
        cell.textContent = d;
        cell.disabled = date < min || date > today;
        cell.tabIndex = -1;
        cell.classList.toggle('in', date > draft.from && date < draft.to);
        cell.classList.toggle('start', date === draft.from);
        cell.classList.toggle('end', date === draft.to);
        cell.classList.toggle('today', date === today);
        // A screen reader hears what the shading shows: Von, Bis or a day between them.
        const role = [
          date === today && t('today'),
          date === draft.from && t('rangeFrom'),
          date === draft.to && t('rangeTo'),
          date > draft.from && date < draft.to && t('inRange'),
        ].filter(Boolean);
        cell.setAttribute('aria-label', [`${T.longDate(d, m)} ${y}`, ...role].join(', '));
        cells.push(cell);
      }
      $('cal-grid').replaceChildren(...cells);
      const days = cells.filter((c) => c.dataset.date && !c.disabled);
      const target = days.find((c) => c.dataset.date === focus) || days[0];
      if (target) {
        target.tabIndex = 0;
      }
    }

    function show(date) {
      focus = clamp(date);
      shown = focus.slice(0, 7);
      render();
    }

    function open() {
      draft = { ...start() };
      end = 'from';
      $('range-pop').hidden = false;
      // Opened from Zeitraum in a month, the title still names what is open.
      $('month-button').setAttribute('aria-controls', 'range-pop');
      $('month-button').setAttribute('aria-expanded', 'true');
      show(draft.from);
      $('cal-grid').querySelector('[tabindex="0"]')?.focus();
    }

    function close(restoreFocus) {
      if ($('range-pop').hidden) {
        return;
      }
      $('range-pop').hidden = true;
      $('month-button').setAttribute('aria-expanded', 'false');
      $('month-button').setAttribute(
        'aria-controls',
        spanOf(current()) ? 'range-pop' : 'month-pop',
      );
      if (restoreFocus) {
        $('month-button').focus();
      }
    }

    function apply(span) {
      close(true);
      onApply(span);
    }

    /** Von takes the day and hands over to Bis; a day before Von moves Von. */
    function pick(date) {
      if (end === 'from' || date < draft.from) {
        draft.from = date;
        draft.to = draft.to < date ? date : draft.to;
        end = 'to';
      } else {
        draft.to = date;
      }
      focus = date;
      render();
      $('cal-grid').querySelector(`[data-date="${date}"]`)?.focus();
    }

    $('month-button').addEventListener('click', () => {
      if (spanOf(current())) {
        if ($('range-pop').hidden) {
          open();
        } else {
          close(true);
        }
      }
    });
    for (const which of ['from', 'to']) {
      $(`range-${which}`).addEventListener('click', () => {
        end = which;
        show(draft[which]);
      });
    }
    $('cal-prev').addEventListener('click', () => show(shiftMonth(`${shown}-01`, -1)));
    $('cal-next').addEventListener('click', () => show(shiftMonth(`${shown}-01`, 1)));
    $('cal-grid').addEventListener('click', (event) => {
      const cell = event.target.closest('button');
      if (cell && !cell.disabled) {
        pick(cell.dataset.date);
      }
    });
    /** Arrow keys move by a day or a week, Page Up and Down by a month. */
    $('cal-grid').addEventListener('keydown', (event) => {
      const at = document.activeElement?.dataset?.date;
      let to;
      if (!at) {
        return;
      }
      if (event.key in DAY_KEYS) {
        to = shiftDay(at, DAY_KEYS[event.key]);
      } else if (event.key === 'PageUp' || event.key === 'PageDown') {
        to = shiftMonth(at, event.key === 'PageUp' ? -1 : 1);
      } else {
        return;
      }
      event.preventDefault();
      show(to);
      $('cal-grid').querySelector('[tabindex="0"]')?.focus();
    });
    document.querySelectorAll('[data-quick]').forEach((b) =>
      b.addEventListener('click', () => {
        const today = berlinDay();
        const from = {
          30: shiftDay(today, -29),
          year: `${today.slice(0, 4)}-01-01`,
          all: earliest(),
        }[b.dataset.quick];
        apply({ from: clamp(from), to: today });
      }),
    );
    $('range-apply').addEventListener('click', () => apply({ ...draft }));
    document.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('#range-pop, #month-button, [data-mode]')) {
        close(false);
      }
    });
    $('range-pop').addEventListener('focusout', (event) => {
      if (event.relatedTarget && !event.relatedTarget.closest('#range-pop, #month-button')) {
        close(false);
      }
    });

    return { open, close, isOpen: () => !$('range-pop').hidden };
  }

  /**
   * Monat or Zeitraum: Monat opens the month the interval ends in, Zeitraum opens the interval
   * picker on the month shown.
   */
  function modeSwitch({ current, months, onMonth, range }) {
    document.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        const span = spanOf(current());
        if (b.dataset.mode === 'month' && span) {
          const month = span.to.slice(0, 7);
          onMonth(months().includes(month) ? month : months()[0]);
        } else if (b.dataset.mode === 'range' && !span) {
          if (range.isOpen()) {
            range.close(true);
          } else {
            range.open();
          }
        }
      }),
    );
  }

  /** The interval a month stands for, up to today. */
  function monthSpan(month) {
    const [y, m] = month.split('-').map(Number);
    const last = isoDate(y, m, daysIn(y, m));
    const today = berlinDay();
    return { from: `${month}-01`, to: last < today ? last : today };
  }

  // The server writes the page in the chosen language, so a switch is a reload with the new choice.
  document.querySelectorAll('.lang button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') !== 'true') {
        document.cookie = `${LANG_COOKIE}=${b.dataset.lang}; Path=/monitoring; Max-Age=31536000; SameSite=Lax; Secure`;
        location.reload();
      }
    }),
  );

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

  /** What the server wrote into the page: an interval, else a month. */
  const initialKey = () => {
    const { from, to, month } = $('month-button').dataset;
    return from && to ? spanKey({ from, to }) : month || berlinMonth();
  };

  return {
    T,
    t,
    $,
    storage,
    monthLabel,
    berlinMonth,
    berlinDay,
    daysIn,
    isoDate,
    shiftDay,
    weekSpan,
    columnsOf,
    spanKey,
    spanOf,
    query,
    label,
    address,
    monthSpan,
    initialKey,
    monthPicker,
    rangePicker,
    modeSwitch,
  };
})();
