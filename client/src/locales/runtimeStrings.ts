import type { i18n as I18n } from 'i18next';

const NAMESPACE = 'translation';

/**
 * Adds `pick(language)` to every loaded translation bundle. Locales load lazily and replace their
 * whole bundle, so the strings are added again whenever a bundle is added.
 */
export function installStrings(
  i18n: I18n,
  pick: (language: string) => Record<string, string>,
): () => void {
  const apply = (language: string, namespace: string) => {
    if (namespace !== NAMESPACE) {
      return;
    }
    const strings = pick(language);
    const current = Object.entries(strings).every(
      ([key, value]) => i18n.getResource(language, namespace, key) === value,
    );
    if (!current) {
      i18n.addResourceBundle(language, namespace, strings, true, true);
    }
  };
  for (const language of Object.keys(i18n.store.data)) {
    apply(language, NAMESPACE);
  }
  i18n.store.on('added', apply);
  return () => i18n.store.off('added', apply);
}
