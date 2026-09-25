const {
  parsePolicyConfig,
  parseSourceBlock,
  mergeSources,
  anchorClaims,
  formatAnswer,
  buildGroundingPrompt,
} = require('./groundingPolicy');

const chunk = (domain, uri = `stub-${domain}`) => ({ web: { uri, title: domain, domain } });
const source = (n, domain) => ({ n, domain, jahr: '2023', beschreibung: 'x' });

describe('parsePolicyConfig', () => {
  test('passes a configured exclusion list through', () => {
    const policy = parsePolicyConfig({ excludeDomains: ['junk.example'] });

    expect(policy).toEqual({ excludeDomains: ['junk.example'] });
  });

  test('excludes content farms without a mounted config', () => {
    expect(parsePolicyConfig(null).excludeDomains.length).toBeGreaterThan(0);
  });

  test('reads nothing but the exclusion list from a mounted config', () => {
    const policy = parsePolicyConfig({
      tiers: [{ name: 'AWMF', domains: ['awmf.org'] }],
      excludeDomains: ['junk.example'],
    });

    expect(policy).toEqual({ excludeDomains: ['junk.example'] });
  });

  test('rejects an exclusion list that is not a list of domains', () => {
    expect(() => parsePolicyConfig({ excludeDomains: 'junk.example' })).toThrow(/excludeDomains/);
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
  const answer = (over) =>
    formatAnswer({ body: 'A', entries: [entry()], dropped: [], grounded: true, ...over });

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

  test('answers with a warning rather than refusing when no search backed the answer', () => {
    const out = answer({ body: 'Aus dem Gedächtnis.', entries: [], grounded: false });

    expect(out).toContain('Aus dem Gedächtnis.');
    expect(out).toMatch(/WARNUNG/);
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
