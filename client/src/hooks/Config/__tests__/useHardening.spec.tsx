import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { renderHook } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import { FAVICON_PLACEHOLDER } from '~/utils/faviconPlaceholder';
import useHardening from '../useHardening';
import store from '~/store';

type Voice = Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'>;

class FakeSynthesis extends EventTarget {
  getVoices(): Voice[] {
    return [
      { name: 'Anna', lang: 'de-DE', localService: true },
      { name: 'Google Deutsch', lang: 'de-DE', localService: false },
    ];
  }

  speak(): void {}
}

const baseConfig = { appTitle: 'Synthetic', allowAccountDeletion: true } as TStartupConfig;

function initialize({ set }: MutableSnapshot) {
  set(store.speechToText, true);
  set(store.textToSpeech, true);
  set(store.conversationMode, true);
  set(store.cloudBrowserVoices, true);
  set(store.engineTTS, 'external');
}

function render(startupConfig: TStartupConfig) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot initializeState={initialize}>{children}</RecoilRoot>
  );
  return renderHook(
    () => {
      useHardening(startupConfig);
      return {
        speechToText: useRecoilValue(store.speechToText),
        textToSpeech: useRecoilValue(store.textToSpeech),
        conversationMode: useRecoilValue(store.conversationMode),
        cloudBrowserVoices: useRecoilValue(store.cloudBrowserVoices),
        engineTTS: useRecoilValue(store.engineTTS),
      };
    },
    { wrapper },
  );
}

function failFavicon(): HTMLImageElement {
  const favicon = document.createElement('img');
  favicon.src = 'https://www.google.com/s2/favicons?domain=example.org&sz=32';
  document.body.appendChild(favicon);
  favicon.dispatchEvent(new Event('error'));
  return favicon;
}

let synth: FakeSynthesis;

beforeEach(() => {
  localStorage.clear();
  synth = new FakeSynthesis();
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useHardening', () => {
  it('changes nothing when the startup config carries no flags', () => {
    const { result } = render(baseConfig);

    expect(result.current).toEqual({
      speechToText: true,
      textToSpeech: true,
      conversationMode: true,
      cloudBrowserVoices: true,
      engineTTS: 'external',
    });
    expect(synth.getVoices()).toHaveLength(2);
    expect(failFavicon().src).toContain('google.com/s2/favicons');
  });

  it('keeps read-aloud on local voices and turns off what leaves the device', () => {
    const { result, unmount } = render({
      ...baseConfig,
      speechLocalOnly: true,
      strictBrowserEgress: true,
    } as TStartupConfig);

    expect(result.current).toEqual({
      speechToText: false,
      textToSpeech: true,
      conversationMode: false,
      cloudBrowserVoices: false,
      engineTTS: 'browser',
    });
    expect(synth.getVoices().map((voice) => voice.name)).toEqual(['Anna']);
    expect(failFavicon().src).toBe(FAVICON_PLACEHOLDER);

    unmount();
    expect(synth.getVoices()).toHaveLength(2);
  });
});
