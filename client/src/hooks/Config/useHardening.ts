import { useEffect } from 'react';
import type { TStartupConfig } from 'librechat-data-provider';
import { installFaviconFallback } from '~/utils/faviconPlaceholder';
import { installLocalVoiceGuard } from '~/utils/speechGuard';
import useLocalSpeechOnly from './useLocalSpeechOnly';

/** Flags the server adds to the startup config for this deployment's hardening. */
function readFlag(startupConfig: TStartupConfig | undefined, key: string): boolean {
  const config: Record<string, unknown> = { ...startupConfig };
  return config[key] === true;
}

/** Applies the hardening the startup config flags; with no flags set it does nothing. */
export default function useHardening(startupConfig?: TStartupConfig) {
  const speechLocalOnly = readFlag(startupConfig, 'speechLocalOnly');
  const strictBrowserEgress = readFlag(startupConfig, 'strictBrowserEgress');

  useLocalSpeechOnly(speechLocalOnly);

  useEffect(() => {
    if (!speechLocalOnly || typeof window.speechSynthesis === 'undefined') {
      return;
    }
    return installLocalVoiceGuard(window.speechSynthesis);
  }, [speechLocalOnly]);

  useEffect(() => {
    if (!strictBrowserEgress) {
      return;
    }
    return installFaviconFallback(document);
  }, [strictBrowserEgress]);
}
