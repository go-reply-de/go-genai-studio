import { installLocalVoiceGuard } from '../speechGuard';

type Voice = Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'>;

const local: Voice = { name: 'Anna', lang: 'de-DE', localService: true };
const cloud: Voice = { name: 'Google Deutsch', lang: 'de-DE', localService: false };

/** Stand-in for `window.speechSynthesis`, which jsdom does not provide. */
class FakeSynthesis extends EventTarget {
  voices: Voice[] = [local, cloud];
  spoken: Utterance[] = [];
  getVoices(): Voice[] {
    return this.voices;
  }

  speak(utterance: Utterance): void {
    this.spoken.push(utterance);
  }
}

class Utterance extends EventTarget {
  constructor(public voice: Voice | null) {
    super();
  }
}

function setup() {
  const synth = new FakeSynthesis();
  const voicesChanged = jest.fn();
  synth.addEventListener('voiceschanged', voicesChanged);
  const uninstall = installLocalVoiceGuard(synth as unknown as SpeechSynthesis);
  const speak = (voice: Voice | null) => {
    const utterance = new Utterance(voice);
    const failed = jest.fn();
    utterance.addEventListener('error', failed);
    (synth as unknown as SpeechSynthesis).speak(utterance as unknown as SpeechSynthesisUtterance);
    return failed;
  };
  return { synth, voicesChanged, uninstall, speak };
}

describe('installLocalVoiceGuard', () => {
  it('offers only on-device voices and asks the voice list to re-read them', () => {
    const { synth, voicesChanged } = setup();

    expect(synth.getVoices()).toEqual([local]);
    expect(voicesChanged).toHaveBeenCalledTimes(1);
  });

  it('speaks with an on-device voice', () => {
    const { synth, speak } = setup();

    const failed = speak(local);

    expect(synth.spoken).toHaveLength(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('refuses a cloud voice and a missing voice instead of speaking', () => {
    const { synth, speak } = setup();

    const cloudFailed = speak(cloud);
    const defaultFailed = speak(null);

    expect(synth.spoken).toHaveLength(0);
    expect(cloudFailed).toHaveBeenCalledTimes(1);
    expect(defaultFailed).toHaveBeenCalledTimes(1);
  });

  it('restores the browser behaviour when uninstalled', () => {
    const { synth, voicesChanged, uninstall, speak } = setup();

    uninstall();
    speak(cloud);

    expect(synth.getVoices()).toEqual([local, cloud]);
    expect(synth.spoken).toHaveLength(1);
    expect(voicesChanged).toHaveBeenCalledTimes(2);
  });
});
