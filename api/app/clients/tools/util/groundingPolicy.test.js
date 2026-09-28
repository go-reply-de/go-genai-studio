const {
  parsePolicyConfig,
  parseSourceBlock,
  mergeSources,
  anchorClaims,
  unbackedStatements,
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

describe('anchorClaims', () => {
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  /** A grounding support located the way Vertex reports it: UTF-8 byte offsets plus the text. */
  const supportFor = (text, passage, groundingChunkIndices, from = 0) => {
    const at = text.indexOf(passage, from);
    return {
      segment: {
        startIndex: bytes(text.slice(0, at)),
        endIndex: bytes(text.slice(0, at + passage.length)),
        text: passage,
      },
      groundingChunkIndices,
    };
  };
  const entry = (domain) => ({ domain, uri: `stub-${domain}`, jahr: null, beschreibung: null });

  test('puts an anchor behind each passage Google attributes to a kept source', () => {
    const text =
      'Bis 4,5 h nach Symptombeginn [1]. Danach nicht [1].\n[[QUELLEN]]\n1|awmf.org|2023|S2e';

    const body = anchorClaims({
      text,
      supports: [supportFor(text, 'Bis 4,5 h nach Symptombeginn', [0])],
      chunks: [chunk('awmf.org')],
      entries: [entry('awmf.org')],
      numbering: new Map([[1, 1]]),
      turn: 2,
    });

    expect(body).toBe('Bis 4,5 h nach Symptombeginn. \\ue202turn2search0 Danach nicht.');
  });

  test('gives every attributed sentence its own anchor', () => {
    const text = 'Feste Nahrung bis 6 h vorher. Klare Flüssigkeit bis 2 h vorher.';

    const body = anchorClaims({
      text,
      supports: [
        supportFor(text, 'Feste Nahrung bis 6 h vorher.', [0]),
        supportFor(text, 'Klare Flüssigkeit bis 2 h vorher.', [1]),
      ],
      chunks: [chunk('awmf.org'), chunk('dgn.org')],
      entries: [entry('awmf.org'), entry('dgn.org')],
      numbering: new Map(),
    });

    expect(body).toBe(
      'Feste Nahrung bis 6 h vorher. \\ue202turn0search0 Klare Flüssigkeit bis 2 h vorher. \\ue202turn0search1',
    );
  });

  test('anchors the occurrence Google pointed at when a sentence repeats after umlauts', () => {
    const text = 'Für Ältere: Dosis 2,5 mg. Für Jüngere gilt: Dosis 2,5 mg.';

    const body = anchorClaims({
      text,
      supports: [supportFor(text, 'Dosis 2,5 mg.', [0], text.indexOf('Jüngere'))],
      chunks: [chunk('awmf.org')],
      entries: [entry('awmf.org')],
      numbering: new Map(),
    });

    expect(body).toBe(
      'Für Ältere: Dosis 2,5 mg. Für Jüngere gilt: Dosis 2,5 mg. \\ue202turn0search0',
    );
  });

  test('merges nested passages that cite the same source into one anchor', () => {
    const text = 'Bis 4,5 h ist die Lyse zugelassen, danach nur nach Bildgebung.';

    const body = anchorClaims({
      text,
      supports: [
        supportFor(text, 'Bis 4,5 h ist die Lyse zugelassen', [0]),
        supportFor(text, text, [0]),
      ],
      chunks: [chunk('awmf.org')],
      entries: [entry('awmf.org')],
      numbering: new Map(),
    });

    expect(body).toBe(`${text} \\ue202turn0search0`);
  });

  test('groups several sources behind one passage', () => {
    const text = 'Apixaban wird auf 2,5 mg reduziert.';

    const body = anchorClaims({
      text,
      supports: [supportFor(text, text, [1, 0])],
      chunks: [chunk('awmf.org'), chunk('dgn.org')],
      entries: [entry('awmf.org'), entry('dgn.org')],
      numbering: new Map(),
    });

    expect(body).toBe(`${text} \\ue200\\ue202turn0search0\\ue202turn0search1\\ue201`);
  });

  test('numbers an anchor by the source list, not by the search result order', () => {
    const text = 'Laut DGN gilt X.';

    const body = anchorClaims({
      text,
      supports: [supportFor(text, text, [0])],
      chunks: [chunk('dgn.org'), chunk('awmf.org')],
      entries: [entry('awmf.org'), entry('dgn.org')],
      numbering: new Map(),
    });

    expect(body).toBe(`${text} \\ue202turn0search1`);
  });

  test('gives no anchor to a search result that is not among the kept sources', () => {
    const text = 'Kassenleistung Y.';

    const body = anchorClaims({
      text,
      supports: [supportFor(text, text, [1])],
      chunks: [chunk('awmf.org'), chunk('aok.de')],
      entries: [entry('awmf.org')],
      numbering: new Map(),
    });

    expect(body).toBe(text);
  });

  test("removes the model's citation markers but keeps bracketed numbers that are not sources", () => {
    const body = anchorClaims({
      text: 'Studie [2023] zeigt Z [1].',
      supports: [],
      chunks: [],
      entries: [],
      numbering: new Map([[1, null]]),
    });

    expect(body).toBe('Studie [2023] zeigt Z.');
  });

  test('with cut, keeps only the passages a kept source backs', () => {
    const text =
      'Feste Nahrung bis 6 h vorher. Laut Blog auch Kaugummi. Klare Flüssigkeit bis 2 h vorher.';

    const body = anchorClaims({
      text,
      supports: [
        supportFor(text, 'Feste Nahrung bis 6 h vorher.', [0]),
        supportFor(text, 'Laut Blog auch Kaugummi.', [1]),
        supportFor(text, 'Klare Flüssigkeit bis 2 h vorher.', [0]),
      ],
      chunks: [chunk('awmf.org'), chunk('blog.example')],
      entries: [entry('awmf.org')],
      numbering: new Map(),
      cut: true,
    });

    expect(body).toBe(
      'Feste Nahrung bis 6 h vorher. \\ue202turn0search0 Klare Flüssigkeit bis 2 h vorher. \\ue202turn0search0',
    );
  });

  test('with cut, keeps a paragraph break between passages from different paragraphs', () => {
    const text = 'Erste Aussage.\n\nLaut Blog etwas anderes.\n\nZweite Aussage.';

    const body = anchorClaims({
      text,
      supports: [supportFor(text, 'Erste Aussage.', [0]), supportFor(text, 'Zweite Aussage.', [0])],
      chunks: [chunk('awmf.org')],
      entries: [entry('awmf.org')],
      numbering: new Map(),
      cut: true,
    });

    expect(body).toBe('Erste Aussage. \\ue202turn0search0\nZweite Aussage. \\ue202turn0search0');
  });

  test('with cut, leaves nothing when no kept source backs any passage', () => {
    const text = 'Nur ein Blog sagt das.';

    const body = anchorClaims({
      text,
      supports: [supportFor(text, text, [0])],
      chunks: [chunk('blog.example')],
      entries: [],
      numbering: new Map(),
      cut: true,
    });

    expect(body).toBe('');
  });
});

describe('unbackedStatements', () => {
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  const backedBy = (text, passage) => ({
    segment: {
      endIndex: bytes(text.slice(0, text.indexOf(passage) + passage.length)),
      text: passage,
    },
    groundingChunkIndices: [0],
  });
  const awmf = { domain: 'awmf.org', uri: 'stub-awmf.org', jahr: null, beschreibung: null };

  test('collects what no kept source backs, as plain statements', () => {
    const text =
      'Feste Nahrung bis 6 h vorher [1]. Laut Blog auch Kaugummi erlaubt [2].\n' +
      '* **Klare Flüssigkeit:** bis 2 h vorher.\n[[QUELLEN]]\n1|awmf.org|2023|S3\n2|blog.example|-|x';

    const statements = unbackedStatements({
      text,
      supports: [backedBy(text, 'Feste Nahrung bis 6 h vorher')],
      chunks: [chunk('awmf.org'), chunk('blog.example')],
      entries: [awmf],
      numbering: new Map([
        [1, 1],
        [2, null],
      ]),
    });

    expect(statements.map((statement) => statement.text)).toEqual([
      'Laut Blog auch Kaugummi erlaubt.',
      'Klare Flüssigkeit: bis 2 h vorher.',
    ]);
  });

  test('drops every sentence with a dose but keeps thresholds', () => {
    const statements = unbackedStatements({
      text: 'Amoxicillin 1 g dreimal täglich. Bei eGFR unter 30 ml/min nicht anwenden. Insulin 0,1 IE/kg/h.',
      supports: [],
      chunks: [],
      entries: [],
      numbering: new Map(),
    });

    expect(statements.map((statement) => statement.text)).toEqual([
      'Bei eGFR unter 30 ml/min nicht anwenden.',
    ]);
  });

  test('treats spelled-out units as doses too', () => {
    const statements = unbackedStatements({
      text: 'In der ersten Stunde 1 Liter Flüssigkeit. Danach langsamer Ausgleich nach Klinik.',
      supports: [],
      chunks: [],
      entries: [],
      numbering: new Map(),
    });

    expect(statements.map((statement) => statement.text)).toEqual([
      'Danach langsamer Ausgleich nach Klinik.',
    ]);
  });

  test('leaves a partly backed sentence to the backed text instead of splitting it', () => {
    const text = '* **Gadobutrol** (z. B. Gadovist) gilt als bevorzugt.\nEin Satz ganz ohne Beleg.';

    const statements = unbackedStatements({
      text,
      supports: [backedBy(text, 'Gadovist) gilt als bevorzugt')],
      chunks: [chunk('awmf.org')],
      entries: [awmf],
      numbering: new Map(),
    });

    expect(statements.map((statement) => statement.text)).toEqual(['Ein Satz ganz ohne Beleg.']);
  });

  test('keeps an ordinal with its sentence', () => {
    const text = 'Als Mittel der 1. Wahl gilt Fosfomycin.';

    const statements = unbackedStatements({
      text,
      supports: [backedBy(text, 'Wahl gilt Fosfomycin')],
      chunks: [chunk('awmf.org')],
      entries: [awmf],
      numbering: new Map(),
    });

    expect(statements).toEqual([]);
  });

  test('does not split at abbreviations', () => {
    const statements = unbackedStatements({
      text: 'Gabe z. B. als Kurzinfusion. Kontrolle ggf. nach 2 h.',
      supports: [],
      chunks: [],
      entries: [],
      numbering: new Map(),
    });

    expect(statements.map((statement) => statement.text)).toEqual([
      'Gabe z. B. als Kurzinfusion. Kontrolle ggf. nach 2 h.',
    ]);
  });

  test('leaves out headings, labels and sentence fragments', () => {
    const text =
      '### Therapie\nErste Wahl:\nEin Satz mit Beleg, sonst nichts.\nEin echter Satz ohne Beleg.';

    const statements = unbackedStatements({
      text,
      supports: [backedBy(text, 'Ein Satz mit Beleg')],
      chunks: [chunk('awmf.org')],
      entries: [awmf],
      numbering: new Map(),
    });

    expect(statements.map((statement) => statement.text)).toEqual(['Ein echter Satz ohne Beleg.']);
  });

  test('returns nothing when kept sources back the whole answer', () => {
    const text = 'Feste Nahrung bis 6 h vorher.';

    expect(
      unbackedStatements({
        text,
        supports: [backedBy(text, text)],
        chunks: [chunk('awmf.org')],
        entries: [awmf],
        numbering: new Map(),
      }),
    ).toEqual([]);
  });

  test('names the unlisted sources Google attributes a hint to', () => {
    const text = 'Laut Leitlinie gilt A. Laut Blog gilt B.';
    const blog = {
      domain: 'blog.example',
      uri: 'stub-blog.example',
      jahr: null,
      beschreibung: null,
    };

    const statements = unbackedStatements({
      text,
      supports: [{ ...backedBy(text, 'Laut Blog gilt B.'), groundingChunkIndices: [1] }],
      chunks: [chunk('awmf.org'), chunk('blog.example')],
      entries: [],
      extras: [blog],
      numbering: new Map(),
    });

    expect(statements).toEqual([
      { text: 'Laut Leitlinie gilt A. Laut Blog gilt B.', uris: ['stub-blog.example'] },
    ]);
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

  test('adds the unofficial statements under their own heading, before the sources', () => {
    const out = answer({
      hints: [
        { text: 'Aussage C.', uris: [] },
        { text: 'Aussage D.', uris: [] },
      ],
    });

    expect(out).toContain(
      'A\n\nErgänzende Hinweise ohne offizielle Quelle – bitte eigenständig prüfen:\n- Aussage C.\n- Aussage D.\n\nQuellen:',
    );
  });

  test('anchors a hint to its own source, numbered after the kept ones', () => {
    const blog = { domain: 'blog.example', uri: 'stub-b' };

    const out = answer({
      hints: [{ text: 'Aussage C.', uris: ['stub-b'] }],
      hintSources: [blog],
      turn: 2,
    });

    expect(out).toContain('- Aussage C. \\ue202turn2search1');
    expect(out).toContain('Quellen der Ergänzenden Hinweise:\n2. [blog.example](stub-b)');
  });

  test('keeps the unofficial statements behind the warning when no source backs the answer', () => {
    expect(answer({ body: '', entries: [], hints: [{ text: 'Aussage C.', uris: [] }] })).toBe(
      'WARNUNG: Diese Antwort ist nicht durch eine Websuche belegt.\n\n' +
        'Ergänzende Hinweise ohne offizielle Quelle – bitte eigenständig prüfen:\n- Aussage C.',
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
