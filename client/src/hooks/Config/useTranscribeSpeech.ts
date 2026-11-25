import { useEffect } from 'react';
import { useRecoilState } from 'recoil';
import { installTranscribeSpeechLock } from '~/utils/transcribeSpeechLock';
import store from '~/store';

/** While the server transcribes speech, dictation always goes to it rather than the browser. */
export default function useTranscribeSpeech(enabled: boolean) {
  const [engineSTT, setEngineSTT] = useRecoilState<string>(store.engineSTT);

  useEffect(() => {
    if (enabled && engineSTT !== 'external') {
      setEngineSTT('external');
    }
  }, [enabled, engineSTT, setEngineSTT]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return installTranscribeSpeechLock(document, window);
  }, [enabled]);
}
