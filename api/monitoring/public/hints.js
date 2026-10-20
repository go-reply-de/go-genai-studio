'use strict';

/**
 * Likely personal data in a free text, found only in the browser. The API already masks e-mail
 * addresses, full dates and numbers of six digits or more when it saves a text; what is left are
 * names after a German or English title, partial dates, short numbers and words like "Fallnummer".
 * A hint for the reviewer, not a check: a name without a title goes unnoticed.
 */
const FeedbackHints = (() => {
  const PATTERNS = [
    /\b(?:Herr|Frau|Hr\.|Fr\.|Dr\.|Prof\.|Pat\.|Patientin|Patient|Kollegin|Kollege|Schwester|Pflegerin|Pfleger|Mrs\.?|Mr\.?|Ms\.?|Miss)\s+[A-ZÄÖÜ][\p{L}-]+/gu,
    /\[(?:Nummer|Datum|E-Mail)\]/g,
    /\b\d{1,2}\.\s?\d{1,2}\.(?:\s?\d{2,4})?(?!\d)/g,
    /\b(?:geb\.|geboren|Geburtsdatum|Fallnummer|Fall-Nr\.?|Aufnahmenummer|Station\s+\d+\w*|Zimmer\s+\d+)/giu,
    /\b(?!(?:19|20)\d{2}\b)\d{4,5}\b/g,
  ];

  /** Start and end of each part worth a look, overlapping parts joined. */
  function findHints(text) {
    const ranges = [];
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        ranges.push([match.index, match.index + match[0].length]);
      }
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const joined = [];
    for (const [start, end] of ranges) {
      const previous = joined[joined.length - 1];
      if (previous && start <= previous[1]) {
        previous[1] = Math.max(previous[1], end);
      } else {
        joined.push([start, end]);
      }
    }
    return joined;
  }

  return { findHints };
})();

if (typeof module === 'object') {
  module.exports = FeedbackHints;
}
