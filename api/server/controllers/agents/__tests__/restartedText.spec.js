const { ContentTypes } = require('librechat-data-provider');
const { dropRestartedText } = require('../restartedText');

const text = (value) => ({ type: ContentTypes.TEXT, text: value });
const think = (value) => ({ type: ContentTypes.THINK, think: value });
const toolCall = {
  type: ContentTypes.TOOL_CALL,
  tool_call: { id: 'call_1', name: 'web_grounding_enterprise' },
};
const opening =
  '::quellenvermerk[Diese Angaben sind nicht durch AWMF belegt.]\n\nDie Empfehlungen der STIKO zur Influenza-Impfung umfassen folgende Kernpunkte:';

describe('dropRestartedText', () => {
  test('keeps only the full answer when the model broke off and started over', () => {
    const brokenOff = text(
      `${opening}\n\n- **Standardimpfung:** Eine jährliche Impfung im Herbst wird ab 60 `,
    );
    const full = text(
      `${opening}\n\n- **Standardimpfung ab 60 Jahren:** Die STIKO empfiehlt eine jährliche Impfung.\n\n---\n\n*Achtung*`,
    );
    const parts = [think('Plan'), toolCall, think('Schreiben'), brokenOff, full];

    expect(dropRestartedText(parts)).toEqual([think('Plan'), toolCall, think('Schreiben'), full]);
  });

  test('looks past thinking between the two attempts and keeps it', () => {
    const brokenOff = text(`${opening} Erste`);
    const full = text(`${opening} Zweite, vollständige Fassung.`);

    expect(dropRestartedText([brokenOff, think('Nochmal'), full])).toEqual([
      think('Nochmal'),
      full,
    ]);
  });

  test('keeps text before and after a tool call', () => {
    const before = text(`${opening} Ich suche nach.`);
    const after = text(`${opening} Nach der Suche gilt Folgendes, deutlich länger als zuvor.`);

    expect(dropRestartedText([before, toolCall, after])).toEqual([before, toolCall, after]);
  });

  test('keeps parts that start differently or where the later one is shorter', () => {
    const first = text(`${opening} Eine lange Antwort mit vielen Einzelheiten.`);
    const different = text('Ergänzend dazu ein zweiter Absatz, der anders beginnt als der erste.');
    const shorter = text(`${opening} Kurz.`);

    expect(dropRestartedText([first, different])).toEqual([first, different]);
    expect(dropRestartedText([first, shorter])).toEqual([first, shorter]);
  });

  test('leaves short parts alone, since a few equal characters prove nothing', () => {
    const parts = [text('Ja.'), text('Ja. Und mehr dazu.')];

    expect(dropRestartedText(parts)).toEqual(parts);
  });
});
