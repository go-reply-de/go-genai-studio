/**
 * Restricts browser text-to-speech to on-device voices: the voice list only offers local voices,
 * and an utterance without one is refused, since the browser would otherwise speak it with its
 * default voice, which can be a cloud voice that sends the text off the device. Returns the
 * uninstaller.
 */
export function installLocalVoiceGuard(synth: SpeechSynthesis): () => void {
  const getVoices = synth.getVoices;
  const speak = synth.speak;

  synth.getVoices = function (this: SpeechSynthesis) {
    return getVoices.call(this).filter((voice) => voice.localService === true);
  };
  synth.speak = function (this: SpeechSynthesis, utterance: SpeechSynthesisUtterance) {
    if (utterance.voice?.localService === true) {
      speak.call(this, utterance);
      return;
    }
    /* Reported like any failed utterance, so the caller leaves its speaking state. */
    utterance.dispatchEvent(new Event('error'));
  };
  /* The shared voice list re-reads through the filter. */
  synth.dispatchEvent(new Event('voiceschanged'));

  return () => {
    synth.getVoices = getVoices;
    synth.speak = speak;
    synth.dispatchEvent(new Event('voiceschanged'));
  };
}
