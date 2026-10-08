import { logFeedbackText } from './text';

const ON = { FEEDBACK_TEXT_LOG: 'true' } as NodeJS.ProcessEnv;

function capture(run: () => void): string[] {
  const lines: string[] = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe('logFeedbackText', () => {
  it('prints nothing while the switch is off', () => {
    const lines = capture(() =>
      logFeedbackText({ rating: 'thumbsDown', tag: 'other', text: 'zu lang' }, {}),
    );
    expect(lines).toEqual([]);
  });

  it('prints one JSON line with rating, reason and text only', () => {
    const lines = capture(() =>
      logFeedbackText(
        { rating: 'thumbsDown', tag: 'other', text: '  Antwort zu lang.\nBitte kürzer.  ' },
        ON,
      ),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(lines[0].trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(lines[0])).toEqual({
      severity: 'INFO',
      feedbackText: { rating: 'thumbsDown', tag: 'other', text: 'Antwort zu lang.\nBitte kürzer.' },
    });
  });

  it('never copies other fields of the feedback', () => {
    const feedback = {
      rating: 'thumbsDown',
      tag: 'inaccurate',
      text: 'Dosis fehlte',
      user: 'u-123',
      conversationId: 'c-456',
    };
    const [line] = capture(() => logFeedbackText(feedback, ON));
    expect(Object.keys(JSON.parse(line).feedbackText).sort()).toEqual(['rating', 'tag', 'text']);
    expect(line).not.toMatch(/u-123|c-456/);
  });

  it('skips ratings without text', () => {
    const lines = capture(() => {
      logFeedbackText({ rating: 'thumbsUp', tag: 'clear_well_written' }, ON);
      logFeedbackText({ rating: 'thumbsDown', tag: 'other', text: '   ' }, ON);
      logFeedbackText(null, ON);
      logFeedbackText(undefined, ON);
    });
    expect(lines).toEqual([]);
  });

  it('labels values outside the known ratings and reasons as unknown', () => {
    const [line] = capture(() =>
      logFeedbackText({ rating: 'great', tag: { key: 'other' }, text: 'x' }, ON),
    );
    expect(JSON.parse(line).feedbackText).toMatchObject({ rating: 'unknown', tag: 'unknown' });
  });

  it('caps the text at 500 characters', () => {
    const [line] = capture(() =>
      logFeedbackText({ rating: 'thumbsDown', tag: 'other', text: 'a'.repeat(600) }, ON),
    );
    expect(JSON.parse(line).feedbackText.text).toHaveLength(500);
  });

  it('masks e-mail addresses, dates and long numbers', () => {
    const [line] = capture(() =>
      logFeedbackText(
        {
          rating: 'thumbsDown',
          tag: 'other',
          text: 'Mail an max.muster@example.org, geb. 12.03.1960 und 1960-03-12, Fall 20241234',
        },
        ON,
      ),
    );
    expect(JSON.parse(line).feedbackText.text).toBe(
      'Mail an [E-Mail], geb. [Datum] und [Datum], Fall [Nummer]',
    );
  });
});
