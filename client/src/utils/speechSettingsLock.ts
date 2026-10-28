const STYLE_ID = 'speech-settings-lock';
const LOCK_CLASS = 'speech-settings-locked';

/** Settings the local-only speech policy pins; they snap back if changed. */
const LOCKED_CONTROLS = [
  '#SpeechToText',
  '#CloudBrowserVoices',
  '[aria-labelledby^="engine-tts-dropdown-label"]',
];

/* Pinned controls ignore clicks and their rows show "not allowed" instead of snapping back;
 * the slider is disabled upstream but keeps a pointer cursor. */
const RULES = [
  ...LOCKED_CONTROLS.flatMap((selector) => [
    `:root.${LOCK_CLASS} :has(> ${selector}) { cursor: not-allowed; }`,
    `:root.${LOCK_CLASS} ${selector} { pointer-events: none; opacity: 0.5; }`,
  ]),
  `:root.${LOCK_CLASS} [data-disabled][data-orientation]:has([aria-labelledby="decibel-selector-label"]) { cursor: not-allowed; opacity: 0.5; }`,
].join('\n');

/** Shows the speech settings the policy pins as unavailable. Returns the uninstaller. */
export function installSpeechSettingsLock(doc: Document): () => void {
  doc.documentElement.classList.add(LOCK_CLASS);
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = RULES;
    doc.head.appendChild(style);
  }
  return () => {
    doc.documentElement.classList.remove(LOCK_CLASS);
    doc.getElementById(STYLE_ID)?.remove();
  };
}
