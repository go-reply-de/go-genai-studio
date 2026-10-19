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

    function renderNav(month) {
      const list = months();
      $('month-button').dataset.month = month;
      $('month-title').textContent = monthLabel(month);
      const i = list.indexOf(month);
      setStep($('prev'), i < 0 ? '' : list[i + 1], t('prevMonth'), earlier);
      setStep($('next'), i > 0 ? list[i - 1] : '', t('nextMonth'), later);
    }

    $('month-button').addEventListener('click', () =>
      $('month-pop').hidden ? open() : close(true),
    );
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

  return { T, t, $, storage, monthLabel, berlinMonth, monthPicker };
})();
