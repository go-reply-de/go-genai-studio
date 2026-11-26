import { useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';
import * as Client from '@librechat/client';
import SpeechRecognitionImport from 'react-speech-recognition';
import { dataService, getTokenHeader } from 'librechat-data-provider';
import type { FailureReason } from '~/utils/transcribeRecognition';
import { createTranscribeRecognition } from '~/utils/transcribeRecognition';
import { installTranscribeSpeechLock } from '~/utils/transcribeSpeechLock';
import { openPcmMicrophone } from '~/utils/pcmMicrophone';
import i18n from '~/locales/i18n';
import store from '~/store';

type ShowToast = (toast: { message: string; status: 'error' }) => void;

/** Tests of the app startup mock @librechat/client without the toast context. */
const useToastContext: () => { showToast?: ShowToast } =
  typeof Client.useToastContext === 'function' ? Client.useToastContext : () => ({});

type SpeechRecognitionLibrary = {
  applyPolyfill: (recognition: unknown) => void;
  removePolyfill: () => void;
};

const FAILURES: Record<'de' | 'en', Record<FailureReason, string>> = {
  de: {
    microphone: 'Kein Zugriff auf das Mikrofon.',
    connection: 'Die Spracheingabe ist gerade nicht erreichbar. Bitte erneut versuchen.',
  },
  en: {
    microphone: 'No access to the microphone.',
    connection: 'Dictation is not available right now. Please try again.',
  },
};

/** The default export is the library object in Vite and a module object in some test setups. */
function speechRecognitionLibrary(): SpeechRecognitionLibrary {
  const library = SpeechRecognitionImport as unknown as Partial<SpeechRecognitionLibrary> & {
    default?: SpeechRecognitionLibrary;
  };
  return typeof library.applyPolyfill === 'function'
    ? (library as SpeechRecognitionLibrary)
    : (library.default as SpeechRecognitionLibrary);
}

function transcribeUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/speech/transcribe`;
}

/**
 * While the server transcribes speech, the browser engine streams to it: LibreChat shows the
 * text live, and the browser vendor's recognizer never receives audio.
 */
export default function useTranscribeSpeech(enabled: boolean) {
  const { showToast } = useToastContext();
  const toast = useRef(showToast);
  toast.current = showToast;
  const [engineSTT, setEngineSTT] = useRecoilState<string>(store.engineSTT);

  useEffect(() => {
    if (enabled && engineSTT !== 'browser') {
      setEngineSTT('browser');
    }
  }, [enabled, engineSTT, setEngineSTT]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const uninstallLock = installTranscribeSpeechLock(document, window);
    const library = speechRecognitionLibrary();
    library.applyPolyfill(
      createTranscribeRecognition({
        url: transcribeUrl,
        getToken: () => getTokenHeader()?.replace(/^Bearer /, ''),
        refreshToken: async () => {
          await dataService.getUser();
        },
        openMicrophone: openPcmMicrophone,
        defaultLanguage: () => i18n.language,
        onFailure: (reason) => {
          const messages = i18n.language?.startsWith('de') ? FAILURES.de : FAILURES.en;
          toast.current?.({ message: messages[reason], status: 'error' });
        },
      }),
    );
    return () => {
      library.removePolyfill();
      uninstallLock();
    };
  }, [enabled]);
}
