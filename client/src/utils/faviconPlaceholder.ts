/** A globe glyph inlined as data, so it loads where remote images are blocked. */
export const FAVICON_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238e8ea0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'/%3E%3Cpath d='M2 12h20'/%3E%3C/svg%3E";

/** Source favicons are fetched from this service, which the strict egress policy blocks. */
const FAVICON_SERVICE = 'https://www.google.com/s2/favicons';

/**
 * Shows the globe instead of a broken image when a source favicon fails to load. Image errors do
 * not bubble, so the listener captures them at the document. Returns the uninstaller.
 */
export function installFaviconFallback(doc: Document): () => void {
  const onError = (event: Event) => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.src.startsWith(FAVICON_SERVICE)) {
      image.src = FAVICON_PLACEHOLDER;
    }
  };
  doc.addEventListener('error', onError, true);
  return () => doc.removeEventListener('error', onError, true);
}
