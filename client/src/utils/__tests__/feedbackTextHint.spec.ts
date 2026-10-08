import i18next from 'i18next';
import { installFeedbackTextHint } from '../feedbackTextHint';

const UPSTREAM_EN = {
  com_ui_feedback_more_information: 'Provide additional feedback',
  com_ui_feedback_placeholder: 'Please provide any additional feedback here',
  com_ui_feedback_positive: 'Love this',
};
const UPSTREAM_DE = {
  com_ui_feedback_more_information: 'Zusätzliches Feedback',
  com_ui_feedback_placeholder: 'Geben Sie hier bitte weiteres Feedback an',
};

async function freshI18n() {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: UPSTREAM_EN } },
    partialBundledLanguages: true,
  });
  return i18n;
}

describe('installFeedbackTextHint', () => {
  it('replaces title and placeholder of the languages already loaded', async () => {
    const i18n = await freshI18n();
    const uninstall = installFeedbackTextHint(i18n);

    expect(i18n.t('com_ui_feedback_placeholder')).toBe(
      'What was it about, and what went wrong? Please no patient data, names or case numbers.',
    );
    expect(i18n.t('com_ui_feedback_more_information')).toBe(
      'Additional feedback – evaluated without your name',
    );
    expect(i18n.t('com_ui_feedback_positive')).toBe('Love this');
    uninstall();
  });

  it('applies the German hint again after the German bundle loads', async () => {
    const i18n = await freshI18n();
    const uninstall = installFeedbackTextHint(i18n);

    i18n.addResourceBundle('de', 'translation', UPSTREAM_DE, true, true);

    expect(i18n.getResource('de', 'translation', 'com_ui_feedback_placeholder')).toBe(
      'Worum ging es, und was hat gestört? Bitte keine Patientendaten, Namen oder Fallnummern.',
    );
    expect(i18n.getResource('de', 'translation', 'com_ui_feedback_more_information')).toBe(
      'Zusätzliches Feedback – wird ohne Ihren Namen ausgewertet',
    );
    uninstall();
  });

  it('leaves bundles loaded after uninstalling as they are', async () => {
    const i18n = await freshI18n();
    installFeedbackTextHint(i18n)();

    i18n.addResourceBundle('de', 'translation', UPSTREAM_DE, true, true);

    expect(i18n.getResource('de', 'translation', 'com_ui_feedback_placeholder')).toBe(
      'Geben Sie hier bitte weiteres Feedback an',
    );
  });
});
