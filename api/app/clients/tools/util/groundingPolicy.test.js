const {
  isDomainInTier,
  partitionChunks,
  attributeClaims,
  evaluateTier,
  runCascade,
  buildTierQuery,
  formatAnswer,
  parseTierConfig,
  narrowTiers,
  byteToCharIndex,
  citationPoints,
  annotateInline,
  buildRankedQuery,
  rankResponse,
} = require('./groundingPolicy');

describe('isDomainInTier', () => {
  test('matches a subdomain of a listed domain', () => {
    const tier = { name: 'Literature', domains: ['nih.gov'] };

    expect(isDomainInTier('pubmed.ncbi.nlm.nih.gov', tier)).toBe(true);
  });
});

describe('partitionChunks', () => {
  test('separates chunks from unlisted domains', () => {
    const tier = { name: 'German official', domains: ['awmf.org'] };
    const chunks = [
      { web: { uri: 'stub-1', domain: 'awmf.org', title: 'awmf.org' } },
      { web: { uri: 'stub-2', domain: 'ratgeber.medium.com', title: 'ratgeber.medium.com' } },
    ];

    const { inTier, offTier } = partitionChunks(chunks, tier);

    expect(inTier.map((c) => c.domain)).toEqual(['awmf.org']);
    expect(offTier.map((c) => c.domain)).toEqual(['ratgeber.medium.com']);
  });
});

describe('isDomainInTier edge cases', () => {
  test('never matches when the chunk carries no domain', () => {
    const tier = { name: 'German official', domains: ['awmf.org'] };

    expect(isDomainInTier(undefined, tier)).toBe(false);
  });
});

describe('partitionChunks index preservation', () => {
  test('keeps each chunk original position so supports can be resolved', () => {
    const tier = { name: 'German official', domains: ['awmf.org'] };
    const chunks = [
      { web: { uri: 'stub-1', domain: 'ratgeber.medium.com' } },
      { web: { uri: 'stub-2', domain: 'awmf.org' } },
    ];

    const { inTier } = partitionChunks(chunks, tier);

    expect(inTier[0].index).toBe(1);
  });
});

describe('attributeClaims', () => {
  test('drops claims backed only by off-tier chunks', () => {
    const supports = [
      { groundingChunkIndices: [0], segment: { text: 'Amoxicillin 3 x 1.000 mg p. o.' } },
      { groundingChunkIndices: [1], segment: { text: 'Laut einem Blogbeitrag reicht Ruhe.' } },
    ];

    const claims = attributeClaims(supports, [0]);

    expect(claims.map((c) => c.text)).toEqual(['Amoxicillin 3 x 1.000 mg p. o.']);
  });
});

describe('attributeClaims offsets', () => {
  test('carries the segment end offset so a citation can be placed', () => {
    const supports = [
      { groundingChunkIndices: [0], segment: { text: 'Lamotrigin', startIndex: 12, endIndex: 42 } },
    ];

    expect(attributeClaims(supports, [0])[0].endIndex).toBe(42);
  });
});

describe('evaluateTier', () => {
  const awmf = { name: 'AWMF-Leitlinienregister', domains: ['awmf.org'] };

  test('treats the NO_SOURCE_IN_SCOPE sentinel as a miss', () => {
    const response = { text: 'NO_SOURCE_IN_SCOPE', chunks: [], supports: [] };

    expect(evaluateTier(response, awmf).hit).toBe(false);
  });

  test('misses when every returned chunk is off-tier', () => {
    const response = {
      text: 'Ruhe und Tee helfen.',
      chunks: [{ web: { uri: 'stub-1', domain: 'ratgeber.medium.com' } }],
      supports: [{ groundingChunkIndices: [0], segment: { text: 'Ruhe und Tee helfen.' } }],
    };

    expect(evaluateTier(response, awmf).hit).toBe(false);
  });

  test('hits when an in-tier chunk backs at least one claim', () => {
    const response = {
      text: 'Amoxicillin 3 x 1.000 mg p. o.',
      chunks: [{ web: { uri: 'stub-1', domain: 'awmf.org' } }],
      supports: [
        { groundingChunkIndices: [0], segment: { text: 'Amoxicillin 3 x 1.000 mg p. o.' } },
      ],
    };

    expect(evaluateTier(response, awmf).hit).toBe(true);
  });

  test('reports off-tier domains so the caller can exclude them on retry', () => {
    const response = {
      text: 'Amoxicillin 3 x 1.000 mg p. o.',
      chunks: [
        { web: { uri: 'stub-1', domain: 'awmf.org' } },
        { web: { uri: 'stub-2', domain: 'ratgeber.medium.com' } },
      ],
      supports: [
        { groundingChunkIndices: [0], segment: { text: 'Amoxicillin 3 x 1.000 mg p. o.' } },
      ],
    };

    expect(evaluateTier(response, awmf).offTierDomains).toEqual(['ratgeber.medium.com']);
  });

  test('carries the answer text through so the result can be rendered', () => {
    const response = {
      text: 'Amoxicillin 3 x 1.000 mg p. o.',
      chunks: [{ web: { uri: 'stub-1', domain: 'awmf.org' } }],
      supports: [
        { groundingChunkIndices: [0], segment: { text: 'Amoxicillin 3 x 1.000 mg p. o.' } },
      ],
    };

    expect(evaluateTier(response, awmf).text).toBe('Amoxicillin 3 x 1.000 mg p. o.');
  });
});

describe('runCascade', () => {
  const tiers = [
    { name: 'AWMF-Leitlinienregister', domains: ['awmf.org'] },
    { name: 'Deutsche Fachbehörden', domains: ['rki.de'] },
    { name: 'Fachliteratur', domains: ['pubmed.ncbi.nlm.nih.gov'] },
  ];

  const hitFrom = (domain) => ({
    text: 'Amoxicillin 3 x 1.000 mg p. o.',
    chunks: [{ web: { uri: 'stub-1', domain } }],
    supports: [{ groundingChunkIndices: [0], segment: { text: 'Amoxicillin 3 x 1.000 mg p. o.' } }],
  });

  test('stops at the first tier that hits, leaving later tiers untried', async () => {
    const asked = [];
    const ask = async (tier) => {
      asked.push(tier.name);
      return hitFrom('awmf.org');
    };

    const result = await runCascade({ tiers, ask });

    expect(asked).toEqual(['AWMF-Leitlinienregister']);
    expect(result.hit).toBe(true);
  });

  test('tries every configured tier when no cap is set', async () => {
    const asked = [];
    const ask = async (tier) => {
      asked.push(tier.name);
      return { text: 'NO_SOURCE_IN_SCOPE', chunks: [], supports: [] };
    };
    const fourTiers = [...tiers, { name: 'Fachliteratur EU', domains: ['ema.europa.eu'] }];

    await runCascade({ tiers: fourTiers, ask });

    expect(asked).toHaveLength(4);
  });

  test('stops after the configured tier cap even when tiers remain', async () => {
    const asked = [];
    const ask = async (tier) => {
      asked.push(tier.name);
      return { text: 'NO_SOURCE_IN_SCOPE', chunks: [], supports: [] };
    };

    await runCascade({ tiers, ask, maxTiers: 2 });

    expect(asked).toEqual(['AWMF-Leitlinienregister', 'Deutsche Fachbehörden']);
  });
});

describe('buildTierQuery', () => {
  const awmf = {
    name: 'AWMF-Leitlinienregister',
    domains: ['awmf.org', 'register.awmf.org'],
  };

  test('restricts the search to the tier domains and offers the sentinel escape', () => {
    const prompt = buildTierQuery('Erstlinientherapie der Pneumonie', awmf);

    expect(prompt).toContain('awmf.org');
    expect(prompt).toContain('register.awmf.org');
    expect(prompt).toContain('NO_SOURCE_IN_SCOPE');
  });

  test('carries the original question through unchanged', () => {
    const prompt = buildTierQuery('Erstlinientherapie der Pneumonie', awmf);

    expect(prompt).toContain('Erstlinientherapie der Pneumonie');
  });

  test('asks for each source own identifier, since titles carry only the domain', () => {
    const prompt = buildTierQuery('Erstlinientherapie der Pneumonie', awmf);

    expect(prompt).toMatch(/AWMF-Register|PMID|DOI/);
  });
});

describe('formatAnswer', () => {
  test('reports that nothing approved was found when every tier missed', () => {
    const out = formatAnswer({ hit: false, claims: [], sources: [] });

    expect(out).toMatch(/no approved source/i);
  });

  const cleanHit = {
    hit: true,
    tier: { name: 'AWMF-Leitlinienregister' },
    text: 'Amoxicillin 3 x 1.000 mg p. o. ist Mittel der Wahl.',
    claims: [{ text: 'Amoxicillin 3 x 1.000 mg p. o. ist Mittel der Wahl.', chunkIndices: [0] }],
    sources: [
      {
        index: 0,
        uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABC',
        domain: 'awmf.org',
      },
    ],
    offTierDomains: [],
  };

  test('renders the answer, the tier it came from, and a linked source per domain', () => {
    const out = formatAnswer(cleanHit);

    expect(out).toContain('Amoxicillin 3 x 1.000 mg p. o. ist Mittel der Wahl.');
    expect(out).toContain('AWMF-Leitlinienregister');
    expect(out).toContain('awmf.org');
    expect(out).toContain('https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABC');
  });

  test('cites each claim inline when two sources back the answer', () => {
    const body = 'Lamotrigin ist Mittel der ersten Wahl. Lacosamid kann erwogen werden.';
    const bytesTo = (upTo) => Buffer.byteLength(body.slice(0, upTo), 'utf8');

    const out = formatAnswer({
      hit: true,
      tier: { name: 'AWMF-Leitlinienregister' },
      text: body,
      claims: [
        { text: 'a', endIndex: bytesTo(37), chunkIndices: [0] },
        { text: 'b', endIndex: bytesTo(68), chunkIndices: [1] },
      ],
      sources: [
        { index: 0, uri: 'https://stub/a', domain: 'awmf.org' },
        { index: 1, uri: 'https://stub/b', domain: 'register.awmf.org' },
      ],
      offTierDomains: [],
    });

    expect(out).toContain('Mittel der ersten Wahl [\\[1\\]][s1].');
    expect(out).toContain('erwogen werden [\\[2\\]][s2].');
    expect(out).toContain('[s1]: https://stub/a');
    expect(out).toContain('[s2]: https://stub/b');
  });

  test('lists two documents from the same domain separately', () => {
    const out = formatAnswer({
      ...cleanHit,
      sources: [
        { index: 0, uri: 'https://stub/doc-a', domain: 'awmf.org' },
        { index: 1, uri: 'https://stub/doc-b', domain: 'awmf.org' },
      ],
    });

    expect(out).toContain('https://stub/doc-a');
    expect(out).toContain('https://stub/doc-b');
  });

  test('falls back to attributed claims only when off-tier sources were present', () => {
    const contaminated = {
      ...cleanHit,
      text: 'Amoxicillin ist Mittel der Wahl. Ein Blog empfiehlt nur Ruhe.',
      claims: [{ text: 'Amoxicillin ist Mittel der Wahl.', chunkIndices: [0] }],
      offTierDomains: ['ratgeber.medium.com'],
    };

    const out = formatAnswer(contaminated);

    expect(out).toContain('Amoxicillin ist Mittel der Wahl.');
    expect(out).not.toContain('Ein Blog empfiehlt nur Ruhe.');
  });
});

describe('parseTierConfig', () => {
  test('keeps the configured tier order', () => {
    const raw = {
      tiers: [
        { name: 'AWMF-Leitlinienregister', domains: ['register.awmf.org', 'awmf.org'] },
        { name: 'Deutsche Fachbehörden', domains: ['rki.de', 'g-ba.de'] },
      ],
    };

    expect(parseTierConfig(raw).map((t) => t.name)).toEqual([
      'AWMF-Leitlinienregister',
      'Deutsche Fachbehörden',
    ]);
  });

  test('rejects a tier with no domains rather than silently approving nothing', () => {
    const raw = { tiers: [{ name: 'Leer', domains: [] }] };

    expect(() => parseTierConfig(raw)).toThrow(/Leer/);
  });
});

describe('narrowTiers', () => {
  const tiers = [
    { name: 'AWMF-Leitlinienregister', domains: ['awmf.org', 'register.awmf.org'] },
    { name: 'Deutsche Fachbehörden', domains: ['rki.de', 'g-ba.de'] },
  ];

  test('returns the admin tiers untouched when the user configured nothing', () => {
    expect(narrowTiers(tiers, '')).toEqual(tiers);
  });

  test('keeps only the domains the user listed', () => {
    const narrowed = narrowTiers(tiers, 'awmf.org, rki.de');

    expect(narrowed.map((t) => t.domains)).toEqual([['awmf.org'], ['rki.de']]);
  });

  test('drops a tier the user narrowed away entirely', () => {
    const narrowed = narrowTiers(tiers, 'awmf.org');

    expect(narrowed.map((t) => t.name)).toEqual(['AWMF-Leitlinienregister']);
  });

  test('cannot widen the admin list with a domain that is not on it', () => {
    const narrowed = narrowTiers(tiers, 'awmf.org, ratgeber.medium.com');

    expect(narrowed.flatMap((t) => t.domains)).toEqual(['awmf.org']);
  });
});

describe('byteToCharIndex', () => {
  test('maps a UTF-8 byte offset onto the JS string index', () => {
    // "Für " is 5 bytes (ü is two) but 4 characters.
    const text = 'Für fokale Epilepsie';

    expect(byteToCharIndex(text, 5)).toBe(4);
  });

  test('is the identity for pure ASCII', () => {
    expect(byteToCharIndex('Lamotrigin first', 11)).toBe(11);
  });
});

describe('citationPoints', () => {
  test('returns the insertion point just before the closing period', () => {
    const text = 'Lamotrigin ist Mittel der Wahl.';

    expect(citationPoints(text)).toEqual([text.indexOf('.')]);
  });

  test('does not treat the German abbreviation "z. B." as a sentence end', () => {
    const text = 'Gabe von z. B. Lamotrigin. Danach Kontrolle.';

    expect(citationPoints(text)).toHaveLength(2);
  });

  test('keeps "p. o." and dosage abbreviations intact', () => {
    const text = 'Amoxicillin 3 x 1.000 mg p. o. ist Mittel der Wahl. Danach Kontrolle.';

    expect(citationPoints(text)).toHaveLength(2);
  });
});

describe('annotateInline', () => {
  const text = 'Lamotrigin ist Mittel der ersten Wahl. Lacosamid kann erwogen werden.';
  const bytesTo = (upTo) => Buffer.byteLength(text.slice(0, upTo), 'utf8');
  const twoSources = [
    { index: 0, uri: 'https://stub/a', domain: 'awmf.org' },
    { index: 1, uri: 'https://stub/b', domain: 'awmf.org' },
  ];
  const twoClaims = [
    { text: 'Lamotrigin ist Mittel der ersten Wahl', endIndex: bytesTo(37), chunkIndices: [0] },
    { text: 'Lacosamid kann erwogen werden', endIndex: bytesTo(68), chunkIndices: [1] },
  ];

  test('places each marker before the closing period of its sentence', () => {
    expect(annotateInline(text, twoClaims, twoSources)).toBe(
      'Lamotrigin ist Mittel der ersten Wahl [\\[1\\]][s1]. Lacosamid kann erwogen werden [\\[2\\]][s2].',
    );
  });

  test('renders each marker as a reference-style link', () => {
    const out = annotateInline(text, twoClaims, twoSources);

    expect(out).toContain('[\\[1\\]][s1]');
    expect(out).toContain('[\\[2\\]][s2]');
  });

  test('leaves the text alone when a single source backs everything', () => {
    const oneSource = [{ index: 0, uri: 'https://stub/a', domain: 'awmf.org' }];
    const claims = [{ text: 'x', endIndex: bytesTo(37), chunkIndices: [0] }];

    expect(annotateInline(text, claims, oneSource)).toBe(text);
  });

  test('does not repeat a marker when nested spans cite the same source', () => {
    const nested = [
      { text: 'a', endIndex: bytesTo(37), chunkIndices: [0] },
      { text: 'b', endIndex: bytesTo(20), chunkIndices: [0] },
      { text: 'c', endIndex: bytesTo(68), chunkIndices: [1] },
    ];

    expect(annotateInline(text, nested, twoSources)).toBe(
      'Lamotrigin ist Mittel der ersten Wahl [\\[1\\]][s1]. Lacosamid kann erwogen werden [\\[2\\]][s2].',
    );
  });
});

describe('formatAnswer with nested grounding spans', () => {
  test('does not repeat text when one cited span contains another', () => {
    const text = 'Lamotrigin ist erste Wahl. Lacosamid ist Zusatztherapie.';
    const bytesTo = (upTo) => Buffer.byteLength(text.slice(0, upTo), 'utf8');

    const out = formatAnswer({
      hit: true,
      tier: { name: 'Deutsche Fachbehörden' },
      text,
      claims: [
        {
          text: 'Lamotrigin ist erste Wahl',
          startIndex: 0,
          endIndex: bytesTo(25),
          chunkIndices: [0],
        },
        {
          text: 'Lamotrigin ist erste Wahl. Lacosamid ist Zusatztherapie',
          startIndex: 0,
          endIndex: bytesTo(55),
          chunkIndices: [0],
        },
      ],
      sources: [{ index: 0, uri: 'https://stub/a', domain: 'g-ba.de' }],
      // An off-tier domain forces the attributed-claims-only path.
      offTierDomains: ['thieme.de'],
    });

    expect(out.match(/Lamotrigin/g)).toHaveLength(1);
  });
});

describe('single-call ranking', () => {
  const tiers = [
    { name: 'AWMF-Leitlinienregister', domains: ['awmf.org'] },
    { name: 'Deutsche Fachbehörden', domains: ['rki.de', 'g-ba.de'] },
  ];
  const responseWith = (...domains) => ({
    text: 'Lamotrigin ist Mittel der ersten Wahl.',
    chunks: domains.map((d, i) => ({ web: { uri: `https://stub/${i}`, domain: d } })),
    supports: domains.map((_, i) => ({
      groundingChunkIndices: [i],
      segment: { text: 'Lamotrigin ist Mittel der ersten Wahl.', startIndex: 0, endIndex: 37 },
    })),
  });

  test('names every approved domain, preferred tier first', () => {
    const prompt = buildRankedQuery('Therapie der Epilepsie', tiers);

    expect(prompt.indexOf('awmf.org')).toBeLessThan(prompt.indexOf('g-ba.de'));
    expect(prompt).toContain('rki.de');
    expect(prompt).toContain('NO_SOURCE_IN_SCOPE');
  });

  test('prefers the highest tier present in one response', () => {
    const result = rankResponse(responseWith('g-ba.de', 'awmf.org'), tiers);

    expect(result.tier.name).toBe('AWMF-Leitlinienregister');
  });

  test('falls to the next tier when the preferred one is absent', () => {
    const result = rankResponse(responseWith('g-ba.de'), tiers);

    expect(result.tier.name).toBe('Deutsche Fachbehörden');
  });

  test('misses when no approved domain is present', () => {
    expect(rankResponse(responseWith('wikipedia.org'), tiers).hit).toBe(false);
  });
});
