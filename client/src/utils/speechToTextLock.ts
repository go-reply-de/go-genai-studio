const STYLE_ID = 'speech-to-text-lock';
const LOCK_CLASS = 'speech-to-text-locked';

/* The master switch ignores clicks and its row shows "not allowed" instead of the switch
 * snapping back; the slider is disabled upstream but keeps a pointer cursor. */
const RULES = [
  `:root.${LOCK_CLASS} :has(> #SpeechToText) { cursor: not-allowed; }`,
  `:root.${LOCK_CLASS} #SpeechToText { pointer-events: none; opacity: 0.5; }`,
  `:root.${LOCK_CLASS} [data-disabled][data-orientation]:has([aria-labelledby="decibel-selector-label"]) { cursor: not-allowed; opacity: 0.5; }`,
].join('\n');

/** Shows the speech-to-text settings as unavailable. Returns the uninstaller. */
export function installSpeechToTextLock(doc: Document): () => void {
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
