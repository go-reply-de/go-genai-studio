'use strict';

// Runs before the first paint so a dark system never flashes light: "light", "dark" or, unset, the system's choice.
(() => {
  let theme = null;
  try {
    theme = localStorage.getItem('monitoring-theme');
  } catch {
    /* no storage: follow the system */
  }
  const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
})();
