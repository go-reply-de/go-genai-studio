const {
  isVerified,
  parsePolicyConfig,
  parseSourceBlock,
  mergeSources,
  anchorClaims,
  formatAnswer,
  buildGroundingPrompt,
} = require('./groundingPolicy');

const chunk = (domain, uri = `stub-${domain}`) => ({ web: { uri, title: domain, domain } });
const source = (n, domain) => ({ n, domain, jahr: '2023', beschreibung: 'x' });

describe('isVerified', () => {
  test('covers subdomains of a verified institution', () => {
    expect(isVerified('register.awmf.org', ['awmf.org'])).toBe(true);
  });

  test('does not match a lookalike domain that merely ends in the same letters', () => {
    expect(isVerified('fake-awmf.org', ['awmf.org'])).toBe(false);
  });
});

describe('parsePolicyConfig', () => {
  test('treats the domains of a mounted tier config as the verified institutions', () => {
    const policy = parsePolicyConfig({
      tiers: [
        { name: 'AWMF', domains: ['awmf.org'] },
        { name: 'Behörden', domains: ['rki.de', 'g-ba.de'] },
      ],
    });

    expect(policy.verifiedDomains).toEqual(['awmf.org', 'rki.de', 'g-ba.de']);
  });

  test('passes a configured exclusion list through', () => {
    const policy = parsePolicyConfig({
      verifiedDomains: ['awmf.org'],
      excludeDomains: ['junk.example'],
    });

    expect(policy.excludeDomains).toEqual(['junk.example']);
  });

  test('still verifies AWMF and excludes content farms without a mounted config', () => {
    const policy = parsePolicyConfig(null);

    expect(isVerified('register.awmf.org', policy.verifiedDomains)).toBe(true);
    expect(policy.excludeDomains.length).toBeGreaterThan(0);
  });

  test('rejects a verified list that contains something other than a domain', () => {
    expect(() => parsePolicyConfig({ verifiedDomains: ['awmf.org', 42] })).toThrow(
      /verifiedDomains/,
    );
  });

  test('rejects an exclusion list that is not a list of domains', () => {
    expect(() =>
      parsePolicyConfig({ verifiedDomains: ['awmf.org'], excludeDomains: 'junk.example' }),
    ).toThrow(/excludeDomains/);
  });

  test('rejects a tier without domains rather than silently verifying nothing', () => {
    expect(() => parsePolicyConfig({ tiers: [{ name: 'Leer', domains: [] }] })).toThrow(/Leer/);
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
  const verifiedDomains = ['awmf.org', 'rki.de'];

  test('drops a cited source the search never returned', () => {
    const { entries, dropped } = mergeSources({
      sources: [source(1, 'awmf.org'), source(2, 'erfunden.de')],
      chunks: [chunk('awmf.org')],
      verifiedDomains,
    });

    expect(entries.map((e) => e.domain)).toEqual(['awmf.org']);
    expect(dropped.map((d) => d.domain)).toEqual(['erfunden.de']);
  });

  test('verifies on the domain the search returned, not the one the model wrote', () => {
    const { entries } = mergeSources({
      sources: [source(1, 'register.awmf.org')],
      chunks: [chunk('awmf.org')],
      verifiedDomains: ['register.awmf.org'],
    });

    expect(entries[0]).toMatchObject({ domain: 'awmf.org', verified: false });
  });

  test('keeps a search result the answer is attributed to, even when the model did not name it', () => {
    const { entries } = mergeSources({
      sources: [source(1, 'awmf.org')],
      chunks: [chunk('netdoktor.de'), chunk('awmf.org')],
      supports: [{ segment: { endIndex: 40, text: 'x' }, groundingChunkIndices: [0, 1] }],
      verifiedDomains,
    });

    expect(entries.map((e) => e.domain)).toEqual(['awmf.org', 'netdoktor.de']);
  });

  test('drops a search result that no passage of the answer is attributed to', () => {
    const { entries } = mergeSources({
      sources: [source(1, 'awmf.org')],
      chunks: [chunk('netdoktor.de'), chunk('awmf.org')],
      supports: [{ segment: { endIndex: 40, text: 'x' }, groundingChunkIndices: [1] }],
      verifiedDomains,
    });

    expect(entries.map((e) => e.domain)).toEqual(['awmf.org']);
  });

  test('links two cited pages from one domain to their own search results', () => {
    const { entries } = mergeSources({
      sources: [source(1, 'doccheck.com'), source(2, 'doccheck.com')],
      chunks: [chunk('doccheck.com', 'stub-1'), chunk('doccheck.com', 'stub-2')],
      verifiedDomains,
    });

    expect(entries.map((e) => e.uri)).toEqual(['stub-1', 'stub-2']);
  });

  test('merges repeated citations of one search result into a single entry', () => {
    const { entries, numbering } = mergeSources({
      sources: [source(1, 'doccheck.com'), source(2, 'doccheck.com')],
      chunks: [chunk('doccheck.com', 'stub-1')],
      verifiedDomains,
    });

    expect(entries.map((e) => e.uri)).toEqual(['stub-1']);
    expect([...numbering]).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  test('puts verified institutions first and numbers to match', () => {
    const { entries, numbering } = mergeSources({
      sources: [source(1, 'esur-cm.org'), source(2, 'rki.de')],
      chunks: [chunk('esur-cm.org'), chunk('rki.de')],
      verifiedDomains,
    });

    expect(entries.map((e) => e.domain)).toEqual(['rki.de', 'esur-cm.org']);
    expect([...numbering]).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  test('numbers kept sources consecutively and maps dropped ones to nothing', () => {
    const { numbering } = mergeSources({
      sources: [source(1, 'awmf.org'), source(2, 'erfunden.de'), source(3, 'rki.de')],
      chunks: [chunk('awmf.org'), chunk('rki.de')],
      verifiedDomains,
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
  const entry = (domain) => ({
    domain,
    uri: `stub-${domain}`,
    jahr: null,
    beschreibung: null,
    verified: false,
  });

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
    verified: true,
    ...over,
  });
  const lineFor = (out, domain) => out.split('\n').find((l) => l.includes(`[${domain}](`));
  const answer = (over) =>
    formatAnswer({ body: 'A', entries: [entry()], dropped: [], grounded: true, ...over });

  test('links each source by its domain with verification, year and description', () => {
    const line = lineFor(answer({}), 'awmf.org');

    expect(line).toContain('[awmf.org](stub-a)');
    expect(line).toMatch(/2023/);
    expect(line).toMatch(/S3/);
    expect(line).not.toMatch(/nicht verifiziert/);
    expect(line).not.toMatch(/klassifiziert/);
  });

  test('does not warn when a search backed the answer', () => {
    expect(answer({})).not.toMatch(/WARNUNG/);
  });

  test('marks a source outside the verified register as unverified', () => {
    const out = answer({
      entries: [entry({ domain: 'esur-cm.org', uri: 'stub-e', verified: false })],
    });

    expect(lineFor(out, 'esur-cm.org')).toMatch(/nicht verifiziert/);
  });

  test('points out when no verified institution backs the answer', () => {
    expect(answer({ entries: [entry({ verified: false })] })).toMatch(/verifizierten Register/);
    expect(answer({})).not.toMatch(/verifizierten Register/);
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
