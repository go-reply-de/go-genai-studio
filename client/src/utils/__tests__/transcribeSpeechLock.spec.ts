import { installTranscribeSpeechLock } from '../transcribeSpeechLock';

type RecognitionWindow = Window & {
  webkitSpeechRecognition?: unknown;
  SpeechRecognition?: unknown;
};

describe('installTranscribeSpeechLock', () => {
  let started: number;

  beforeEach(() => {
    started = 0;
    class FakeRecognition {
      start() {
        started++;
      }
    }
    (window as RecognitionWindow).webkitSpeechRecognition = FakeRecognition;
  });

  afterEach(() => {
    delete (window as RecognitionWindow).webkitSpeechRecognition;
    document.documentElement.className = '';
    document.getElementById('transcribe-speech-lock')?.remove();
  });

  function startBrowserRecognition() {
    const Recognition = (window as RecognitionWindow).webkitSpeechRecognition as new () => {
      start: () => void;
    };
    new Recognition().start();
  }

  it('locks the speech-to-text engine dropdown', () => {
    const uninstall = installTranscribeSpeechLock(document, window);
    const rules = document.getElementById('transcribe-speech-lock')?.textContent ?? '';

    expect(document.documentElement.classList.contains('transcribe-speech-locked')).toBe(true);
    expect(rules).toContain(
      '[aria-labelledby="engine-stt-dropdown-label"] { pointer-events: none;',
    );

    uninstall();
    expect(document.documentElement.classList.contains('transcribe-speech-locked')).toBe(false);
    expect(document.getElementById('transcribe-speech-lock')).toBeNull();
  });

  it('keeps the browser engine from recording, and restores it on uninstall', () => {
    const uninstall = installTranscribeSpeechLock(document, window);
    startBrowserRecognition();
    expect(started).toBe(0);

    uninstall();
    startBrowserRecognition();
    expect(started).toBe(1);
  });
});
