const fs = require('fs');
const path = require('path');
const texts = require('./public/i18n');

describe('review page texts', () => {
  it('has every text in German and in English', () => {
    expect(Object.keys(texts.en).sort()).toEqual(Object.keys(texts.de).sort());
    expect(Object.keys(texts.en.reasons).sort()).toEqual(Object.keys(texts.de.reasons).sort());
    for (const lang of ['de', 'en']) {
      expect(texts[lang].months).toHaveLength(12);
      expect(texts[lang].short).toHaveLength(12);
      const empty = Object.entries(texts[lang]).filter(
        ([, value]) => typeof value === 'string' && !value.trim(),
      );
      expect(empty).toEqual([]);
    }
  });

  it('knows every text the page and its script ask for', () => {
    const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
    const used = [...page.matchAll(/\{\{t:(\w+)\}\}/g), ...script.matchAll(/\bt\('(\w+)'/g)].map(
      (match) => match[1],
    );
    expect(used.length).toBeGreaterThan(50);
    expect(used.filter((key) => !(key in texts.de))).toEqual([]);
  });

  it('writes dates the way each language does', () => {
    const { de, en } = texts;
    expect([de.date(3, 10), de.span(12), de.longDate(12, 10), de.shortDate(12, 10)]).toEqual([
      '03.10.',
      '1.–12.',
      '12. Oktober',
      '12. Okt.',
    ]);
    expect([en.date(3, 10), en.span(12), en.longDate(12, 10), en.shortDate(12, 10)]).toEqual([
      '3 Oct',
      '1–12',
      '12 October',
      '12 Oct',
    ]);
  });
});
