const { ContentTypes } = require('librechat-data-provider');

/** How much of a text part's start must repeat for the next part to count as starting it over. */
const SAME_START = 40;

const textOf = (part) => (typeof part?.text === 'string' ? part.text : (part?.text?.value ?? ''));
const startOf = (part) => textOf(part).replace(/\s+/g, ' ').trim().slice(0, SAME_START);

/**
 * Gemini sometimes breaks off an answer mid-sentence (for instance after browsing a page) and
 * writes it again from the start in a new text part. Drops the broken-off attempt, so the
 * answer is saved once; thinking between the two attempts stays.
 * @param {Array<Record<string, unknown>>} parts
 */
function dropRestartedText(parts) {
  if (!Array.isArray(parts)) {
    return parts;
  }
  return parts.filter((part, index) => {
    if (part?.type !== ContentTypes.TEXT) {
      return true;
    }
    const next = parts.slice(index + 1).find((p) => p?.type !== ContentTypes.THINK);
    return !(
      next?.type === ContentTypes.TEXT &&
      startOf(part).length === SAME_START &&
      startOf(next) === startOf(part) &&
      textOf(next).length > textOf(part).length
    );
  });
}

module.exports = { dropRestartedText };
