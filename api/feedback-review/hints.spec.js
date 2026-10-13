const { findHints } = require('./public/hints');

/** The parts of a synthetic text the review page marks as possible personal data. */
const marked = (text) => findHints(text).map(([start, end]) => text.slice(start, end));

describe('possible personal data in a free text', () => {
  it('marks names after a title or role', () => {
    expect(marked('Frau Beispiel bekam die falsche Dosis.')).toEqual(['Frau Beispiel']);
    expect(marked('Laut Pat. Muster fehlte der Hinweis.')).toEqual(['Pat. Muster']);
  });

  it('marks placeholders, partial dates, keywords and short numbers', () => {
    expect(marked('Ruf [Nummer] an, Termin am 12.3. auf Station 4b, Fallnummer 4711.')).toEqual([
      '[Nummer]',
      '12.3.',
      'Station 4b',
      'Fallnummer',
      '4711',
    ]);
  });

  it('leaves years, doses and names without a title alone', () => {
    expect(
      marked('Die Leitlinie von 2024 empfiehlt 400 mg; Anna Schmidt war einverstanden.'),
    ).toEqual([]);
  });
});
