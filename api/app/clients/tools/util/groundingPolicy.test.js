const {
  parsePolicyConfig,
  parseSourceBlock,
  mergeSources,
  splitAnswer,
  formatAnswer,
  buildGroundingPrompt,
} = require('./groundingPolicy');

const chunk = (domain, uri = `stub-${domain}`) => ({ web: { uri, title: domain, domain } });
const source = (n, domain) => ({ n, domain, jahr: '2023', beschreibung: 'x' });

describe('parsePolicyConfig', () => {
  test('passes the configured exclusion and source lists through', () => {
    const policy = parsePolicyConfig({
      excludeDomains: ['junk.example'],
      sourceDomains: ['awmf.org', 'rki.de'],
    });

    expect(policy).toEqual({
      excludeDomains: ['junk.example'],
      sourceDomains: ['awmf.org', 'rki.de'],
    });
  });

  test('excludes nothing and keeps every source without a mounted config', () => {
    expect(parsePolicyConfig(null)).toEqual({ excludeDomains: [], sourceDomains: [] });
  });

  test('normalises the configured hosts', () => {
    const policy = parsePolicyConfig({
      excludeDomains: ['https://www.Junk.example/page'],
      sourceDomains: ['www.AWMF.org'],
    });

    expect(policy).toEqual({ excludeDomains: ['junk.example'], sourceDomains: ['awmf.org'] });
  });

  test('ignores the tier list of the older tool', () => {
    const policy = parsePolicyConfig({
      tiers: [{ name: 'AWMF', domains: ['awmf.org'] }],
      excludeDomains: ['junk.example'],
    });

    expect(policy).toEqual({ excludeDomains: ['junk.example'], sourceDomains: [] });
  });

  test('rejects a list that is not a list of domains', () => {
    expect(() => parsePolicyConfig({ excludeDomains: 'junk.example' })).toThrow(/excludeDomains/);
    expect(() => parsePolicyConfig({ sourceDomains: ['awmf.org', 42] })).toThrow(/sourceDomains/);
  });
});

describe('parseSourceBlock', () => {
  test('separates the answer from the trailing source block', () => {
    const text =
      'Thrombolyse bis 4,5 h [1].\n\n[[QUELLEN]]\n1|awmf.org|2023|S2e-Leitlinie Schlaganfall';

    expect(parseSourceBlock(text)).toEqual({
      body: 'Thrombolyse bis 4,5 h [1].',
      sources: [
        { n: 1, domain: 'awmf.org', jahr: '2023', beschreibung: 'S2e-Leitlinie Schlaganfall' },
      ],
    });
  });

  test('reports no sources when the model left the block out', () => {
    expect(parseSourceBlock('Nur Text.')).toEqual({ body: 'Nur Text.', sources: null });
  });

  test('reduces a URL written in place of a domain to its host', () => {
    const { sources } = parseSourceBlock(
      'A\n[[QUELLEN]]\n1|https://www.awmf.org/leitlinien/detail/030-046|2023|x',
    );

    expect(sources[0].domain).toBe('awmf.org');
  });

  test('reads a block wrapped in a code fence', () => {
    const { sources } = parseSourceBlock('A\n[[QUELLEN]]\n```\n1|rki.de|2024|STIKO\n```');

    expect(sources.map((s) => s.domain)).toEqual(['rki.de']);
  });

  test('treats a dash as an unknown year', () => {
    const { sources } = parseSourceBlock('A\n[[QUELLEN]]\n1|gelbe-liste.de|-|Datenbank');

    expect(sources[0]).toMatchObject({ jahr: null, beschreibung: 'Datenbank' });
  });

  test('finds the year even when the model inserts an extra field before it', () => {
    const { sources } = parseSourceBlock('A\n[[QUELLEN]]\n1|awmf.org|1|2023|S3');

    expect(sources[0]).toMatchObject({ jahr: '2023', beschreibung: 'S3' });
  });

  test('keeps a source whose line carries no year at all', () => {
    const { sources } = parseSourceBlock('A\n[[QUELLEN]]\n1|esur-cm.org|ESUR Guidelines');

    expect(sources[0]).toMatchObject({
      domain: 'esur-cm.org',
      jahr: null,
      beschreibung: 'ESUR Guidelines',
    });
  });

  test('numbers sources by position when the model writes section-style numbers', () => {
    const { sources } = parseSourceBlock('A\n[[QUELLEN]]\n1.1.1|awmf.org|2023\n1.2.1|rki.de|2024');

    expect(sources.map((s) => s.n)).toEqual([1, 2]);
  });

  test('ignores a format template the model echoed back', () => {
    const { sources } = parseSourceBlock(
      'A\n[[QUELLEN]]\nNummer|Domain|Jahr oder -|Kurzbeschreibung\n1|rki.de|2024|STIKO',
    );

    expect(sources.map((s) => s.domain)).toEqual(['rki.de']);
  });
});

describe('mergeSources', () => {
  test('drops a cited source the search never returned', () => {
    const { entries, dropped } = mergeSources({
      sources: [source(1, 'awmf.org'), source(2, 'erfunden.de')],
      chunks: [chunk('awmf.org')],
    });

    expect(entries.map((e) => e.domain)).toEqual(['awmf.org']);
    expect(dropped.map((d) => d.domain)).toEqual(['erfunden.de']);
  });

  test('lists the domain the search returned, not the one the model wrote', () => {
    const { entries } = mergeSources({
      sources: [source(1, 'register.awmf.org')],
      chunks: [chunk('awmf.org')],
    });

    expect(entries[0]).toEqual({
      domain: 'awmf.org',
      uri: 'stub-awmf.org',
      jahr: '2023',
      beschreibung: 'x',
    });
  });

  test('keeps a search result the answer is attributed to, even when the model did not name it', () => {
    const { entries } = mergeSources({
      sources: [source(1, 'awmf.org')],
      chunks: [chunk('netdoktor.de'), chunk('awmf.org')],
      supports: [{ segment: { endIndex: 40, text: 'x' }, groundingChunkIndices: [0, 1] }],
    });

    expect(entries.map((e) => e.domain)).toEqual(['awmf.org', 'netdoktor.de']);
  });

  test('drops a search result that no passage of the answer is attributed to', () => {
    const { entries } = mergeSources({
      sources: [source(1, 'awmf.org')],
      chunks: [chunk('netdoktor.de'), chunk('awmf.org')],
      supports: [{ segment: { endIndex: 40, text: 'x' }, groundingChunkIndices: [1] }],
    });

    expect(entries.map((e) => e.domain)).toEqual(['awmf.org']);
  });

  test('links two cited pages from one domain to their own search results', () => {
    const { entries } = mergeSources({
      sources: [source(1, 'doccheck.com'), source(2, 'doccheck.com')],
      chunks: [chunk('doccheck.com', 'stub-1'), chunk('doccheck.com', 'stub-2')],
    });

    expect(entries.map((e) => e.uri)).toEqual(['stub-1', 'stub-2']);
  });

  test('merges repeated citations of one search result into a single entry', () => {
    const { entries, numbering } = mergeSources({
      sources: [source(1, 'doccheck.com'), source(2, 'doccheck.com')],
      chunks: [chunk('doccheck.com', 'stub-1')],
    });

    expect(entries.map((e) => e.uri)).toEqual(['stub-1']);
    expect([...numbering]).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  test('keeps the order in which the answer cites its sources', () => {
    const { entries, numbering } = mergeSources({
      sources: [source(1, 'esur-cm.org'), source(2, 'rki.de')],
      chunks: [chunk('rki.de'), chunk('esur-cm.org')],
    });

    expect(entries.map((e) => e.domain)).toEqual(['esur-cm.org', 'rki.de']);
    expect([...numbering]).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  test('numbers kept sources consecutively and maps dropped ones to nothing', () => {
    const { numbering } = mergeSources({
      sources: [source(1, 'awmf.org'), source(2, 'erfunden.de'), source(3, 'rki.de')],
      chunks: [chunk('awmf.org'), chunk('rki.de')],
    });

    expect([...numbering]).toEqual([
      [1, 1],
      [2, null],
      [3, 2],
    ]);
  });

  test('keeps only sources on the list, without calling the others fabricated', () => {
    const { entries, dropped, numbering, unlisted } = mergeSources({
      sources: [source(1, 'awmf.org'), source(2, 'thieme-connect.com')],
      chunks: [chunk('awmf.org'), chunk('thieme-connect.com')],
      sourceDomains: ['awmf.org'],
    });

    expect(entries.map((e) => e.domain)).toEqual(['awmf.org']);
    expect(dropped).toEqual([]);
    expect([...numbering]).toEqual([
      [1, 1],
      [2, null],
    ]);
    expect(unlisted).toEqual(['thieme-connect.com']);
  });

  test('keeps an unlisted result out even when the answer is attributed to it', () => {
    const { entries } = mergeSources({
      sources: [],
      chunks: [chunk('thieme-connect.com'), chunk('rki.de')],
      supports: [{ segment: { endIndex: 40, text: 'x' }, groundingChunkIndices: [0, 1] }],
      sourceDomains: ['rki.de'],
    });

    expect(entries.map((e) => e.domain)).toEqual(['rki.de']);
  });

  test('still drops a cited source the search never returned', () => {
    const { dropped } = mergeSources({
      sources: [source(1, 'erfunden.de')],
      chunks: [chunk('awmf.org')],
      sourceDomains: ['awmf.org'],
    });

    expect(dropped.map((d) => d.domain)).toEqual(['erfunden.de']);
  });

  test('keeps every source when no list is configured', () => {
    const { entries, unlisted } = mergeSources({
      sources: [source(1, 'awmf.org'), source(2, 'thieme-connect.com')],
      chunks: [chunk('awmf.org'), chunk('thieme-connect.com')],
    });

    expect(entries.map((e) => e.domain)).toEqual(['awmf.org', 'thieme-connect.com']);
    expect(unlisted).toEqual([]);
  });
});

describe('splitAnswer', () => {
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  /** A grounding support located the way Vertex reports it: UTF-8 byte offsets plus the text. */
  const support = (text, passage, groundingChunkIndices) => {
    const at = text.indexOf(passage);
    return {
      segment: {
        startIndex: bytes(text.slice(0, at)),
        endIndex: bytes(text.slice(0, at + passage.length)),
        text: passage,
      },
      groundingChunkIndices,
    };
  };
  const awmf = { domain: 'awmf.org', uri: 'stub-awmf.org', jahr: null, beschreibung: null };
  const blog = { domain: 'blog.example', uri: 'stub-blog.example', jahr: null, beschreibung: null };
  const split = (text, supports) =>
    splitAnswer({
      text,
      supports,
      chunks: [chunk('awmf.org'), chunk('blog.example')],
      entries: [awmf],
      extras: [blog],
      numbering: new Map(),
    });

  test('keeps a sentence an official source mostly covers and hands the rest to the hints', () => {
    const text = 'Feste Nahrung bis 6 h vorher. Laut Blog auch Kaugummi erlaubt.';

    const { body, hints } = split(text, [
      support(text, 'Feste Nahrung bis 6 h', [0]),
      support(text, 'Laut Blog auch Kaugummi erlaubt.', [1]),
    ]);

    expect(body).toBe('Feste Nahrung bis 6 h vorher. \\ue202turn0search0');
    expect(hints).toEqual([
      {
        topic: null,
        text: 'Laut Blog auch Kaugummi erlaubt.',
        sources: [{ domain: 'blog.example', link: 'stub-blog.example' }],
      },
    ]);
  });

  test('leaves a sentence an official source covers less than half of to the hints', () => {
    const text = 'Klare Flüssigkeit ist bis zwei Stunden vor der Narkose erlaubt.';

    const { body, hints } = split(text, [support(text, 'Klare Flüssigkeit', [0])]);

    expect(body).toBe('');
    expect(hints.map((hint) => hint.text)).toEqual([text]);
  });

  test('keeps headings and list labels with their statements in both parts', () => {
    const text = [
      '### HINTS',
      '* **Kopfimpulstest:**',
      '    * *Zentral:* Die Augen bleiben stabil auf dem Ziel.',
      '    * *Peripher:* Es zeigt sich eine Korrektursakkade.',
    ].join('\n');

    const { body, hints } = split(text, [
      support(text, 'Die Augen bleiben stabil auf dem Ziel.', [0]),
    ]);

    expect(body).toBe(
      '### HINTS\n- Kopfimpulstest:\n  - Zentral: Die Augen bleiben stabil auf dem Ziel. \\ue202turn0search0',
    );
    expect(hints).toEqual([
      {
        topic: 'Kopfimpulstest',
        text: 'Peripher: Es zeigt sich eine Korrektursakkade.',
        sources: [],
      },
    ]);
  });

  test('makes an inline label the topic of its sub-items without repeating it', () => {
    const text = [
      '* **Kopfimpulstest (KIT):** Prüft den vestibulookulären Reflex.',
      '    * *Peripher:* Es zeigt sich eine Korrektursakkade.',
    ].join('\n');

    const { body, hints } = split(text, [
      support(text, 'Prüft den vestibulookulären Reflex.', [0]),
    ]);

    expect(body).toBe(
      '- Kopfimpulstest (KIT): Prüft den vestibulookulären Reflex. \\ue202turn0search0',
    );
    expect(hints).toEqual([
      {
        topic: 'Kopfimpulstest (KIT)',
        text: 'Peripher: Es zeigt sich eine Korrektursakkade.',
        sources: [],
      },
    ]);
  });

  test('treats a short question or colon line as a lead-in, not as a statement', () => {
    const text =
      'Wann ist der Test "zentral"?\nEin einziges zentrales Zeichen genügt für den Verdacht.';

    expect(split(text, []).hints).toEqual([
      {
        topic: 'Wann ist der Test "zentral"?',
        text: 'Ein einziges zentrales Zeichen genügt für den Verdacht.',
        sources: [],
      },
    ]);
  });

  test('keeps a long sentence ending in a colon as a statement that leads its list', () => {
    const text =
      'Die Leitlinie empfiehlt am Krankenbett den erweiterten Test mit Hörprüfung:\n- Fingerreiben vor beiden Ohren.';

    expect(split(text, []).hints).toEqual([
      {
        topic: null,
        text: 'Die Leitlinie empfiehlt am Krankenbett den erweiterten Test mit Hörprüfung:',
        sources: [],
        items: [{ text: 'Fingerreiben vor beiden Ohren.', sources: [] }],
      },
    ]);
  });

  test('moves what an unbacked lead-in introduces along with it, even a backed item', () => {
    const lead =
      'Ein Patient gilt als zentral verdächtig, wenn mindestens eines der folgenden Kriterien erfüllt ist:';
    const text = [
      lead,
      '',
      '1. Der Kopfimpulstest ist normal.',
      '',
      '2. Es besteht eine akute Hörminderung.',
    ].join('\n');

    const { body, hints } = split(text, [
      support(text, 'Es besteht eine akute Hörminderung.', [0]),
    ]);

    expect(body).toBe('');
    expect(hints).toEqual([
      {
        topic: null,
        text: lead,
        sources: [],
        items: [
          { text: 'Der Kopfimpulstest ist normal.', sources: [] },
          { text: 'Es besteht eine akute Hörminderung.', sources: [] },
        ],
      },
    ]);
  });

  test('keeps a backed list under its backed lead-in and names the lead-in above the rest', () => {
    const lead = 'Die Leitlinie nennt für die Therapie der ersten Wahl die folgenden Antibiotika:';
    const text = [lead, '- Fosfomycin als Einmalgabe.', '- Pivmecillinam über drei Tage.'].join(
      '\n',
    );

    const { body, hints } = split(text, [
      support(text, lead, [0]),
      support(text, 'Fosfomycin als Einmalgabe.', [0]),
    ]);

    expect(body).toBe(
      `${lead} \\ue202turn0search0\n- Fosfomycin als Einmalgabe. \\ue202turn0search0`,
    );
    expect(hints).toEqual([
      { topic: lead.replace(/:$/, ''), text: 'Pivmecillinam über drei Tage.', sources: [] },
    ]);
  });

  test('ends a backed lead-in with a full stop when nothing it introduces is backed', () => {
    const lead = 'Die Leitlinie nennt für die Therapie der ersten Wahl die folgenden Antibiotika:';
    const text = [lead, '- Pivmecillinam über drei Tage.'].join('\n');

    expect(split(text, [support(text, lead, [0])]).body).toBe(
      `${lead.replace(/:$/, '.')} \\ue202turn0search0`,
    );
  });

  test('lets a labelled sub-list under an unbacked lead-in keep its own label', () => {
    const text = [
      'Das Akronym HINTS steht für drei Tests am Krankenbett, die nacheinander erfolgen:',
      '1. **Kopfimpuls:**',
      '   * *Zentral:* Der Test ist normal.',
    ].join('\n');

    const { body, hints } = split(text, [support(text, 'Der Test ist normal.', [0])]);

    expect(body).toBe('- Kopfimpuls:\n  - Zentral: Der Test ist normal. \\ue202turn0search0');
    expect(hints.map((hint) => hint.text)).toEqual([
      'Das Akronym HINTS steht für drei Tests am Krankenbett, die nacheinander erfolgen.',
    ]);
  });

  test('keeps the label of a list item on each of its sentences', () => {
    const text =
      '- **Bei Sepsis ohne Schock:** Zunächst weitere Diagnostik. Bleibt der Verdacht, Antibiotika binnen drei Stunden.';
    const later = 'Bleibt der Verdacht, Antibiotika binnen drei Stunden.';

    expect(split(text, [support(text, later, [0])])).toEqual({
      body: `- Bei Sepsis ohne Schock: ${later} \\ue202turn0search0`,
      hints: [
        { topic: null, text: 'Bei Sepsis ohne Schock: Zunächst weitere Diagnostik.', sources: [] },
      ],
      unlisted: '',
    });
    expect(split(text, [support(text, 'Zunächst weitere Diagnostik.', [0])]).hints).toEqual([
      { topic: null, text: `Bei Sepsis ohne Schock: ${later}`, sources: [] },
    ]);
  });

  test('names each hint by the whole path of labels above it', () => {
    const text = [
      '- **Kopfimpuls:**',
      '  - **Befund:**',
      '    - *Peripher:* Es zeigt sich eine Korrektursakkade.',
      '- **Nystagmus:**',
      '  - **Befund:**',
      '    - *Peripher:* Der Nystagmus schlägt in eine Richtung.',
    ].join('\n');

    expect(split(text, []).hints.map((hint) => hint.topic)).toEqual([
      'Kopfimpuls – Befund',
      'Nystagmus – Befund',
    ]);
  });

  test('writes simple formula signs as text', () => {
    const text =
      'Ab einem Alter von $\\ge$ 80 Jahren prüfen. Bei $< 15\\text{ ml/min}$ nicht anwenden.';

    expect(split(text, []).hints.map((hint) => hint.text)).toEqual([
      'Ab einem Alter von ≥ 80 Jahren prüfen. Bei < 15 ml/min nicht anwenden.',
    ]);
  });

  test('turns table rows into statements with their column headers', () => {
    const text = [
      '| Test | Peripher | Zentral |',
      '|---|---|---|',
      '| Kopfimpuls | Sakkade | stabil |',
    ].join('\n');

    expect(split(text, []).hints.map((hint) => hint.text)).toEqual([
      'Kopfimpuls; Peripher: Sakkade; Zentral: stabil',
    ]);
  });

  test('drops every hint with a dose but keeps thresholds', () => {
    const text = 'Amoxicillin 1 g dreimal täglich. Bei eGFR unter 30 ml/min nicht anwenden.';

    expect(split(text, []).hints.map((hint) => hint.text)).toEqual([
      'Bei eGFR unter 30 ml/min nicht anwenden.',
    ]);
  });

  test('keeps a dose an official source backs', () => {
    const text = 'Amoxicillin 1 g dreimal täglich.';

    expect(split(text, [support(text, text, [0])]).body).toBe(
      'Amoxicillin 1 g dreimal täglich. \\ue202turn0search0',
    );
  });

  test('removes stray citation numbers so a label stays a label', () => {
    const text =
      'Kriterien für ein zentrales Ergebnis: [5]\n- Ein unauffälliger Kopfimpulstest spricht für zentral.';

    expect(split(text, []).hints).toEqual([
      {
        topic: 'Kriterien für ein zentrales Ergebnis',
        text: 'Ein unauffälliger Kopfimpulstest spricht für zentral.',
        sources: [],
      },
    ]);
  });

  test('joins the unbacked sentences of one line into one hint', () => {
    const text = 'Erster Satz ohne Beleg. Zweiter Satz ohne Beleg.';

    expect(split(text, []).hints.map((hint) => hint.text)).toEqual([text]);
  });

  test('does not split at abbreviations or ordinals', () => {
    const text = 'Gabe z. B. als Kurzinfusion. Mittel der 1. Wahl ist Fosfomycin.';

    expect(split(text, [support(text, 'Mittel der 1. Wahl ist Fosfomycin.', [0])])).toEqual({
      body: 'Mittel der 1. Wahl ist Fosfomycin. \\ue202turn0search0',
      hints: [{ topic: null, text: 'Gabe z. B. als Kurzinfusion.', sources: [] }],
      unlisted: '',
    });
  });

  test('writes the hints as text along the outline, anchored on the unlisted sources', () => {
    const text = [
      '### Wells-Score',
      '- **Hohe Wahrscheinlichkeit:** Mehr als 4 Punkte.',
      '- Amoxicillin 1 g dreimal täglich.',
      '- Ohne Beleg aus dem Modell selbst.',
    ].join('\n');

    const { body, unlisted } = split(text, [support(text, 'Mehr als 4 Punkte.', [1])]);

    expect(body).toBe('');
    expect(unlisted).toBe(
      [
        '### Wells-Score',
        '- Hohe Wahrscheinlichkeit: Mehr als 4 Punkte. \\ue202turn0search0',
        '- Ohne Beleg aus dem Modell selbst.',
      ].join('\n'),
    );
  });

  test('ends a list before the paragraph that follows it, so the two stay apart', () => {
    const text = [
      '- Aktive Krebserkrankung ergibt einen Punkt.',
      'Klassifikation nach Punkten:',
      '- Wahrscheinlich ab vier Punkten.',
      'Danach folgt die Bildgebung.',
    ].join('\n');
    const backed = [
      'Aktive Krebserkrankung ergibt einen Punkt.',
      'Wahrscheinlich ab vier Punkten.',
    ];

    expect(
      split(
        text,
        backed.map((b) => support(text, b, [0])),
      ).body,
    ).toBe(
      [
        '- Aktive Krebserkrankung ergibt einen Punkt. \\ue202turn0search0',
        '',
        'Klassifikation nach Punkten:',
        '- Wahrscheinlich ab vier Punkten. \\ue202turn0search0',
      ].join('\n'),
    );
    expect(split(text, []).unlisted).toBe('');
  });

  test('leaves the text empty when no source at all can be traced', () => {
    expect(split('Nur Modellwissen ohne jede Quelle.', []).unlisted).toBe('');
  });

  test("removes the model's own citation markers from both parts", () => {
    const text = 'Feste Nahrung bis 6 h vorher [1]. Laut Blog auch Kaugummi [2].';

    const { body, hints } = splitAnswer({
      text,
      supports: [support(text, 'Feste Nahrung bis 6 h vorher', [0])],
      chunks: [chunk('awmf.org'), chunk('blog.example')],
      entries: [awmf],
      extras: [blog],
      numbering: new Map([
        [1, 1],
        [2, null],
      ]),
    });

    expect(body).toBe('Feste Nahrung bis 6 h vorher. \\ue202turn0search0');
    expect(hints.map((hint) => hint.text)).toEqual(['Laut Blog auch Kaugummi.']);
  });
});

describe('formatAnswer', () => {
  const entry = (over) => ({
    domain: 'awmf.org',
    uri: 'stub-a',
    jahr: '2023',
    beschreibung: 'S3',
    ...over,
  });
  const lineFor = (out, domain) => out.split('\n').find((l) => l.includes(`[${domain}](`));
  const answer = (over) => formatAnswer({ body: 'A', entries: [entry()], dropped: [], ...over });

  test('links each source by its domain with year and description', () => {
    const line = lineFor(answer({}), 'awmf.org');

    expect(line).toBe('1. [awmf.org](stub-a) · 2023 · S3');
  });

  test('does not warn when a search backed the answer', () => {
    expect(answer({})).not.toMatch(/WARNUNG/);
  });

  test('never rates a source as verified, checked or unverified', () => {
    const out = answer({ entries: [entry(), entry({ domain: 'esur-cm.org', uri: 'stub-e' })] });

    expect(out).not.toMatch(/verifiziert|Register|geprüft/);
  });

  test('marks where the hints go, between the backed text and its sources', () => {
    expect(answer({ hasHints: true })).toBe(
      'A\n\n::hinweise\n\nQuellen:\n1. [awmf.org](stub-a) · 2023 · S3',
    );
  });

  test('hands over the text of the other sources, led by the note, when no listed source backs it', () => {
    expect(answer({ body: '', entries: [], hasHints: true, unlisted: 'Ein Blog nennt 6 h.' })).toBe(
      '::quellenvermerk[Diese Angaben sind nicht durch AWMF, Fachgesellschaften, Behörden (z. B. RKI, BfArM, EMA) oder die Fachinformation belegt. Sie stammen aus anderen Quellen oder lassen sich keiner Quelle zuordnen.]\n\nEin Blog nennt 6 h.',
    );
  });

  test('hands over only the warning when no source backs the answer', () => {
    expect(answer({ body: 'Aus anderen Quellen.', entries: [] })).toBe(
      'WARNUNG: Diese Antwort ist nicht durch eine Websuche belegt.',
    );
  });

  test('says how many cited sources were removed as unverifiable', () => {
    expect(answer({ dropped: [{ domain: 'erfunden.de' }] })).toMatch(/1 zitierte Quelle.*entfernt/);
  });
});

describe('buildGroundingPrompt', () => {
  test('carries the clinical question through unchanged', () => {
    const query = 'Welches Zeitfenster gilt für die Thrombolyse?';

    expect(buildGroundingPrompt(query)).toContain(query);
  });
});
