import type { i18n as I18n } from 'i18next';

const NAMESPACE = 'translation';

/** The free text is evaluated without ids; the dialog says so and asks for no personal details. */
const HINTS: Record<'de' | 'en', Record<string, string>> = {
  de: {
    com_ui_feedback_more_information: 'Zusätzliches Feedback – wird ohne Ihren Namen ausgewertet',
    com_ui_feedback_placeholder:
      'Worum ging es, und was hat gestört? Bitte keine Patientendaten und keine Angaben zu Beschäftigten.',
  },
  en: {
    com_ui_feedback_more_information: 'Additional feedback – evaluated without your name',
    com_ui_feedback_placeholder:
      'What was it about, and what went wrong? Please no patient data and no details about staff.',
  },
};

function hintsFor(language: string): Record<string, string> {
  return language.toLowerCase().startsWith('de') ? HINTS.de : HINTS.en;
}

/**
 * Replaces the feedback dialog's title and placeholder. Locales load lazily and overwrite their
 * whole bundle, so the hint is applied again whenever a bundle is added.
 */
export function installFeedbackTextHint(i18n: I18n): () => void {
  const apply = (language: string, namespace: string) => {
    if (namespace !== NAMESPACE) {
      return;
    }
    const hints = hintsFor(language);
    const current = Object.entries(hints).every(
      ([key, value]) => i18n.getResource(language, namespace, key) === value,
    );
    if (!current) {
      i18n.addResourceBundle(language, namespace, hints, true, true);
    }
  };
  for (const language of Object.keys(i18n.store.data)) {
    apply(language, NAMESPACE);
  }
  i18n.store.on('added', apply);
  return () => i18n.store.off('added', apply);
}
