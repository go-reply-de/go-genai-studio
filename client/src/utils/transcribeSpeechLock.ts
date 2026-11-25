const STYLE_ID = 'transcribe-speech-lock';
const LOCK_CLASS = 'transcribe-speech-locked';
const ENGINE_DROPDOWN = '[aria-labelledby="engine-stt-dropdown-label"]';

const RULES = [
  `:root.${LOCK_CLASS} :has(> ${ENGINE_DROPDOWN}) { cursor: not-allowed; }`,
  `:root.${LOCK_CLASS} ${ENGINE_DROPDOWN} { pointer-events: none; opacity: 0.5; }`,
].join('\n');

type Recognition = { prototype: { start: () => void } };
type RecognitionWindow = Window & {
  SpeechRecognition?: Recognition;
  webkitSpeechRecognition?: Recognition;
};

/**
 * Keeps dictation on the server's transcription: the engine choice is locked, and the browser
 * engine, which streams audio to the browser vendor, cannot start. Returns the uninstaller.
 */
export function installTranscribeSpeechLock(doc: Document, win: Window): () => void {
  doc.documentElement.classList.add(LOCK_CLASS);
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = RULES;
    doc.head.appendChild(style);
  }

  const recognitionWindow = win as RecognitionWindow;
  const engines = [recognitionWindow.SpeechRecognition, recognitionWindow.webkitSpeechRecognition]
    .filter((engine): engine is Recognition => engine != null)
    .filter((engine, index, all) => all.indexOf(engine) === index);
  const originals = engines.map((engine) => engine.prototype.start);
  engines.forEach((engine) => {
    engine.prototype.start = () => {};
  });

  return () => {
    doc.documentElement.classList.remove(LOCK_CLASS);
    doc.getElementById(STYLE_ID)?.remove();
    engines.forEach((engine, index) => {
      engine.prototype.start = originals[index];
    });
  };
}
