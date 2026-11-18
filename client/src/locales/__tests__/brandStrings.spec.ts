import i18next from 'i18next';
import type { TranslationKeys } from '~/hooks';
import { installBrandStrings } from '../brandStrings';

/** The brand keys are added at runtime, so they aren't in the typed key list. */
const key = (name: string) => name as TranslationKeys;

async function freshI18n() {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: { com_ui_zoom_out: 'Zoom out' } } },
    partialBundledLanguages: true,
  });
  return i18n;
}

describe('installBrandStrings', () => {
  it('adds the English strings to the loaded bundle', async () => {
    const i18n = await freshI18n();
    const uninstall = installBrandStrings(i18n);

    expect(i18n.t(key('com_header_description'))).toBe('Your very own AI Chatbot');
    expect(i18n.t(key('com_ui_tos_instructions'))).toBe(
      'Please review the terms and conditions below.',
    );
    expect(i18n.t('com_ui_zoom_out')).toBe('Zoom out');
    uninstall();
  });

  it('adds the German strings once the German bundle loads, not before', async () => {
    const i18n = await freshI18n();
    const uninstall = installBrandStrings(i18n);

    expect(i18n.hasResourceBundle('de', 'translation')).toBe(false);
    i18n.addResourceBundle('de', 'translation', { com_ui_zoom_out: 'Herauszoomen' }, true, true);

    expect(i18n.getResource('de', 'translation', 'com_header_description')).toBe(
      'Ihr persönlicher KI-Chatbot',
    );
    expect(i18n.getResource('de', 'translation', 'com_ui_zoom_out')).toBe('Herauszoomen');
    uninstall();
  });

  it('leaves other locales to the English fallback', async () => {
    const i18n = await freshI18n();
    const uninstall = installBrandStrings(i18n);

    i18n.addResourceBundle('fr', 'translation', { com_ui_zoom_out: 'Dézoomer' }, true, true);
    await i18n.changeLanguage('fr');

    expect(i18n.getResource('fr', 'translation', 'com_header_description')).toBeUndefined();
    expect(i18n.t(key('com_header_description'))).toBe('Your very own AI Chatbot');
    uninstall();
  });
});
