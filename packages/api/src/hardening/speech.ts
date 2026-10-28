import type { RequestHandler } from 'express';
import { isEnabled } from '~/utils/common';

/**
 * SPEECH_LOCAL_ONLY keeps speech on the user's device: read-aloud only through the browser's
 * on-device voices, and no speech-to-text, since the browser engine streams audio to its vendor.
 */
export function isSpeechLocalOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled(env.SPEECH_LOCAL_ONLY);
}

/** Server speech-to-text and text-to-speech both leave the device; the speech config does not. */
const SERVER_SPEECH_PATH = /^\/(stt|tts)(\/|$)/;

/** Mounted on the speech path ahead of the routers, so no upload is read before the 403. */
export function createSpeechAccessGate(): RequestHandler {
  return (req, res, next) => {
    if (SERVER_SPEECH_PATH.test(req.path)) {
      res.status(403).json({ message: 'Server speech is disabled' });
      return;
    }
    next();
  };
}
