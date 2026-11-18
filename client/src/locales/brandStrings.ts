import type { i18n as I18n } from 'i18next';
import { installStrings } from './runtimeStrings';
import i18n from './i18n';

/** Go GenAI Studio strings, kept out of the upstream locale files. */
const STRINGS: Record<'de' | 'en', Record<string, string>> = {
  de: {
    com_description:
      '\nEine umfassende KI-Chat-Plattform, die Ihnen die volle Kontrolle über Ihre Chat-Erlebnisse bietet. \nIndem sie mehrere KI-Anbieter und fortschrittliche Funktionen in einer einzigen, benutzerfreundlichen Oberfläche vereint, liefert sie die Flexibilität, KI-Assistenten für jede Art von Service oder Workflow mühelos zu erstellen, anzupassen und bereitzustellen.',
    com_header_description: 'Ihr persönlicher KI-Chatbot',
    com_ui_tos_instructions: 'Lesen Sie bitte die folgenden Nutzungsbedingungen sorgfältig durch.',
    com_ui_tos_copyright: '© {{0}} Go Reply. Alle Rechte vorbehalten.',
  },
  en: {
    com_description:
      '\nA comprehensive AI chat platform designed to give you full control over your conversational experiences. \nBy bringing together multiple AI providers and advanced features into one user-friendly interface, it provides the flexibility to build, customize, and deploy AI assistants for any kind of service or workflow effortlessly.',
    com_header_description: 'Your very own AI Chatbot',
    com_ui_tos_instructions: 'Please review the terms and conditions below.',
    com_ui_tos_copyright: '© {{0}} Go Reply. All Rights Reserved.',
  },
};

/** Other locales fall back to the English strings through i18next. */
function stringsFor(language: string): Record<string, string> {
  if (language === 'en') {
    return STRINGS.en;
  }
  return language.toLowerCase().startsWith('de') ? STRINGS.de : {};
}

export function installBrandStrings(instance: I18n = i18n): () => void {
  return installStrings(instance, stringsFor);
}

installBrandStrings();
