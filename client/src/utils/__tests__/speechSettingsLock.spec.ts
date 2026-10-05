import { installSpeechSettingsLock } from '../speechSettingsLock';

describe('installSpeechSettingsLock', () => {
  afterEach(() => {
    document.documentElement.className = '';
    document.getElementById('speech-settings-lock')?.remove();
  });

  it('marks the document and adds the rules once', () => {
    const first = installSpeechSettingsLock(document);
    const second = installSpeechSettingsLock(document);
    const rules = document.getElementById('speech-settings-lock')?.textContent ?? '';

    expect(document.documentElement.classList.contains('speech-settings-locked')).toBe(true);
    expect(document.querySelectorAll('#speech-settings-lock')).toHaveLength(1);
    expect(rules).toContain('#SpeechToText { pointer-events: none;');
    expect(rules).toContain('#CloudBrowserVoices { pointer-events: none;');
    expect(rules).toContain(
      '[aria-labelledby^="engine-tts-dropdown-label"] { pointer-events: none;',
    );

    second();
    first();
  });

  it('removes the class and the rules again', () => {
    const uninstall = installSpeechSettingsLock(document);
    uninstall();

    expect(document.documentElement.classList.contains('speech-settings-locked')).toBe(false);
    expect(document.getElementById('speech-settings-lock')).toBeNull();
  });
});
