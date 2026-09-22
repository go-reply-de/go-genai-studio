const WebGroundingEnterprise = require('../WebGroundingEnterprise');

/** Stands in for the Vertex generative model, returning one canned envelope per call. */
const stubModel = (envelopes) => {
  const queue = [...envelopes];
  const asked = [];
  return {
    asked,
    generateContentStream: async ({ contents }) => {
      asked.push(contents[0].parts[0].text);
      return { response: queue.shift() };
    },
  };
};

const envelope = (text, domain) => ({
  candidates: [
    {
      content: { parts: [{ text }] },
      groundingMetadata: {
        groundingChunks: [{ web: { uri: `https://stub/${domain}`, domain } }],
        groundingSupports: [{ groundingChunkIndices: [0], segment: { text } }],
      },
    },
  ],
});

const tiers = [
  { name: 'AWMF-Leitlinienregister', domains: ['awmf.org'] },
  { name: 'Deutsche Fachbehörden', domains: ['rki.de'] },
];

describe('WebGroundingEnterprise source cascade', () => {
  test('refuses to answer when no tier yields an approved source', async () => {
    const tool = new WebGroundingEnterprise({ override: true });
    tool.tiers = tiers;
    tool.generativeModel = stubModel([
      envelope('Ruhe und Tee helfen.', 'ratgeber.medium.com'),
      envelope('Ruhe und Tee helfen.', 'ratgeber.medium.com'),
    ]);

    const out = await tool._call({ query: 'Erstlinientherapie der Pneumonie' });

    expect(out).toMatch(/no approved source/i);
  });

  test('falls through to the next tier and cites the tier that answered', async () => {
    const tool = new WebGroundingEnterprise({ override: true });
    tool.tiers = tiers;
    tool.generativeModel = stubModel([
      envelope('NO_SOURCE_IN_SCOPE', 'awmf.org'),
      envelope('Meldepflicht nach IfSG.', 'rki.de'),
    ]);

    const out = await tool._call({ query: 'Meldepflicht Pneumonie' });

    expect(out).toContain('Meldepflicht nach IfSG.');
    expect(out).toContain('Deutsche Fachbehörden');
  });
});

describe('WebGroundingEnterprise ranked strategy', () => {
  test('makes exactly one call and still prefers the higher tier', async () => {
    const tool = new WebGroundingEnterprise({ override: true });
    tool.tiers = tiers;
    tool.strategy = 'ranked';
    const model = stubModel([envelope('Meldepflicht nach IfSG.', 'rki.de')]);
    tool.generativeModel = model;

    const out = await tool._call({ query: 'Meldepflicht Pneumonie' });

    expect(model.asked).toHaveLength(1);
    expect(model.asked[0]).toContain('awmf.org');
    expect(model.asked[0]).toContain('rki.de');
    expect(out).toContain('Deutsche Fachbehörden');
  });
});
