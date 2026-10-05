import { FAVICON_PLACEHOLDER, installFaviconFallback } from '../faviconPlaceholder';

function image(src: string): HTMLImageElement {
  const element = document.createElement('img');
  element.src = src;
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('installFaviconFallback', () => {
  it('swaps a source favicon that failed to load for the local globe', () => {
    const uninstall = installFaviconFallback(document);
    const favicon = image('https://www.google.com/s2/favicons?domain=example.org&sz=32');

    favicon.dispatchEvent(new Event('error'));

    expect(favicon.src).toBe(FAVICON_PLACEHOLDER);
    uninstall();
  });

  it('leaves other images and, once uninstalled, favicons alone', () => {
    const uninstall = installFaviconFallback(document);
    const avatar = image('https://example.org/avatar.png');
    avatar.dispatchEvent(new Event('error'));
    expect(avatar.src).toBe('https://example.org/avatar.png');

    uninstall();
    const favicon = image('https://www.google.com/s2/favicons?domain=example.org&sz=32');
    favicon.dispatchEvent(new Event('error'));
    expect(favicon.src).toContain('google.com/s2/favicons');
  });
});
