import { useEffect } from 'react';
import { useRecoilState } from 'recoil';
import { TTSEndpoints } from '~/common';
import store from '~/store';

/**
 * Under local-only speech, read-aloud stays on the browser engine with on-device voices, and
 * everything that sends speech elsewhere is switched off: browser speech-to-text streams audio
 * to the browser vendor, voice mode builds on it, and the other engines run on servers.
 */
export default function useLocalSpeechOnly(localOnly: boolean) {
  const [speechToText, setSpeechToText] = useRecoilState<boolean>(store.speechToText);
  const [conversationMode, setConversationMode] = useRecoilState<boolean>(store.conversationMode);
  const [cloudBrowserVoices, setCloudBrowserVoices] = useRecoilState<boolean>(
    store.cloudBrowserVoices,
  );
  const [engineTTS, setEngineTTS] = useRecoilState<string>(store.engineTTS);

  useEffect(() => {
    if (!localOnly) {
      return;
    }
    if (speechToText) {
      setSpeechToText(false);
    }
    if (conversationMode) {
      setConversationMode(false);
    }
    if (cloudBrowserVoices) {
      setCloudBrowserVoices(false);
    }
    if (engineTTS !== TTSEndpoints.browser) {
      setEngineTTS(TTSEndpoints.browser);
    }
  }, [
    localOnly,
    speechToText,
    conversationMode,
    cloudBrowserVoices,
    engineTTS,
    setSpeechToText,
    setConversationMode,
    setCloudBrowserVoices,
    setEngineTTS,
  ]);
}
