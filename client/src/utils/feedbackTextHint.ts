import type { i18n as I18n } from 'i18next';

const NAMESPACE = 'translation';

/** The free text is evaluated without ids; the dialog says so and asks for no personal details. */
const HINTS: Record<'de' | 'en', Record<string, string>> = {
  de: {
    com_ui_feedback_more_information: 'Ihr Feedback wird anonym ausgewertet',
    com_ui_feedback_placeholder:
      'Was lief nicht gut? Bitte geben Sie keine personenbezogenen Daten ein (z. B. Namen von Beschäftigten oder Patient:innen, Geburtsdaten oder Fallnummern).',
  },
  en: {
    com_ui_feedback_more_information: 'Your feedback is evaluated anonymously',
    com_ui_feedback_placeholder:
      'What did not go well? Please do not enter any personal data (e.g. names of staff or patients, dates of birth or case numbers).',
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
