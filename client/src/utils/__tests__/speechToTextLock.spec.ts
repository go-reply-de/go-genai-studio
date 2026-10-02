import { installSpeechToTextLock } from '../speechToTextLock';

describe('installSpeechToTextLock', () => {
  afterEach(() => {
    document.documentElement.className = '';
    document.getElementById('speech-to-text-lock')?.remove();
  });

  it('marks the document and adds the rules once', () => {
    const first = installSpeechToTextLock(document);
    const second = installSpeechToTextLock(document);

    expect(document.documentElement.classList.contains('speech-to-text-locked')).toBe(true);
    expect(document.querySelectorAll('#speech-to-text-lock')).toHaveLength(1);
    expect(document.getElementById('speech-to-text-lock')?.textContent).toContain(
      '#SpeechToText { pointer-events: none;',
    );

    second();
    first();
  });

  it('removes the class and the rules again', () => {
    const uninstall = installSpeechToTextLock(document);
    uninstall();

    expect(document.documentElement.classList.contains('speech-to-text-locked')).toBe(false);
    expect(document.getElementById('speech-to-text-lock')).toBeNull();
  });
});
