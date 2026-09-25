const fs = require('fs');
const os = require('os');
const path = require('path');

const mockClients = [];
jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: jest.fn().mockImplementation((options) => {
    const client = {
      options,
      models: [],
      preview: {
        getGenerativeModel: (params) => {
          client.models.push(params);
          return {};
        },
      },
    };
    mockClients.push(client);
    return client;
  }),
}));

const WebGroundingEnterprise = require('../WebGroundingEnterprise');

/** Stands in for the Vertex generative model, answering each call with the next canned response. */
const stubModel = (responses) => {
  const queue = [...responses];
  const asked = [];
  return {
    asked,
    generateContent: async ({ contents }) => {
      asked.push(contents[0].parts[0].text);
      const next = queue.shift();
      if (next instanceof Error) {
        throw next;
      }
      return { response: next };
    },
  };
};

const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 };

const groundedResponse = (text, domains, attributed = domains.map((_, i) => [i])) => ({
  candidates: [
    {
      content: { role: 'model', parts: [{ text }] },
      finishReason: 'STOP',
      groundingMetadata: {
        webSearchQueries: ['Thrombolyse Zeitfenster Leitlinie'],
        searchEntryPoint: { renderedContent: '<div></div>' },
        groundingChunks: domains.map((d) => ({
          web: {
            uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${d}`,
            title: d,
            domain: d,
          },
        })),
        groundingSupports: attributed.map((indices, k) => ({
          segment: { endIndex: 10 * (k + 1), text: 'Aussage' },
          groundingChunkIndices: indices,
        })),
      },
    },
  ],
  usageMetadata,
});

/** What Vertex returns when the model searched but nothing could be attributed: queries, no chunks. */
const emptyResponse = (text) => ({
  candidates: [
    {
      content: { role: 'model', parts: [{ text }] },
      finishReason: 'STOP',
      groundingMetadata: {
        webSearchQueries: ['Thrombolyse Zeitfenster Leitlinie AWMF DGN'],
        searchEntryPoint: { renderedContent: '<div></div>' },
      },
    },
  ],
  usageMetadata,
});

const QUERY = 'Welches Zeitfenster gilt für die Thrombolyse bei Frau M., 67 Jahre?';

const toolWith = (search) => {
  const tool = new WebGroundingEnterprise({ override: true });
  tool.policy = { excludeDomains: [] };
  tool.generativeModel = search;
  return tool;
};

/** Invokes the tool the way LibreChat's tool executor does, so the result is a ToolMessage. */
const invokeTool = (tool, turn = 0) =>
  tool.invoke(
    { query: QUERY },
    { toolCall: { id: 'call_1', name: 'web_grounding_enterprise', args: { query: QUERY }, turn } },
  );

describe('WebGroundingEnterprise', () => {
  test('searches once when the search returns results', async () => {
    const search = stubModel([
      groundedResponse('Bis 4,5 h [1].\n[[QUELLEN]]\n1|awmf.org|2023|S2e', ['awmf.org']),
    ]);

    await invokeTool(toolWith(search));

    expect(search.asked).toHaveLength(1);
  });

  test('hands the sources to the Sources panel by domain, in the order the answer cites them', async () => {
    const search = stubModel([
      groundedResponse(
        'Bis 4,5 h [1], laut Leitlinie [2].\n[[QUELLEN]]\n1|dgn.org|2023|DGN\n2|awmf.org|2023|S2e',
        ['dgn.org', 'awmf.org'],
      ),
    ]);

    const { artifact } = await invokeTool(toolWith(search), 2);

    expect(artifact).toEqual({
      web_search: {
        turn: 2,
        organic: [
          {
            position: 1,
            link: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/dgn.org',
            title: 'dgn.org',
            attribution: 'dgn.org',
          },
          {
            position: 2,
            link: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/awmf.org',
            title: 'awmf.org',
            attribution: 'awmf.org',
          },
        ],
      },
    });
  });

  test('marks each claim in the text the agent reads with an anchor to its source', async () => {
    const claim = 'Bis 4,5 h nach Symptombeginn';
    const response = groundedResponse(`${claim} [1].\n[[QUELLEN]]\n1|awmf.org|2023|S2e`, [
      'awmf.org',
    ]);
    response.candidates[0].groundingMetadata.groundingSupports = [
      { segment: { endIndex: Buffer.byteLength(claim), text: claim }, groundingChunkIndices: [0] },
    ];

    const { content } = await invokeTool(toolWith(stubModel([response])), 1);

    expect(content).toContain(`${claim}. \\ue202turn1search0`);
  });

  test('keeps a cited source the search never returned out of the Sources panel', async () => {
    const search = stubModel([
      groundedResponse(
        'A gilt [1]. B gilt [2].\n[[QUELLEN]]\n1|awmf.org|2023|S3\n2|erfunden.de|2024|x',
        ['awmf.org'],
      ),
    ]);

    const { artifact } = await invokeTool(toolWith(search));

    expect(artifact?.web_search?.organic?.map((source) => source.title)).toEqual(['awmf.org']);
  });

  test('retries once with the same question when the first search comes back empty', async () => {
    const search = stubModel([
      emptyResponse('Aus dem Gedächtnis [1].\n[[QUELLEN]]\n1|dgn.org|2022|Leitlinie'),
      groundedResponse('Bis 4,5 h [1].\n[[QUELLEN]]\n1|awmf.org|2023|S2e', ['awmf.org']),
    ]);

    const { content: out } = await invokeTool(toolWith(search));

    expect(search.asked).toHaveLength(2);
    expect(search.asked[1]).toBe(search.asked[0]);
    expect(out).toContain('Bis 4,5 h.');
    expect(out).not.toMatch(/WARNUNG/);
  });

  test('gives up after one retry and says the answer is unbacked', async () => {
    const search = stubModel([
      emptyResponse('Erster Versuch.'),
      emptyResponse('Zweiter Versuch [1].\n[[QUELLEN]]\n1|dgn.org|2022|Leitlinie'),
      groundedResponse('Dritter Versuch.', ['awmf.org']),
    ]);

    const { content: out } = await invokeTool(toolWith(search));

    expect(search.asked).toHaveLength(2);
    expect(out).toMatch(/nicht durch eine Websuche belegt/);
    expect(out).toContain('Zweiter Versuch.');
    expect(out).not.toContain('dgn.org');
  });

  test('drops a cited source the search never returned and numbers the rest', async () => {
    const search = stubModel([
      groundedResponse(
        'A gilt [1]. B gilt [2]. C gilt [3].\n[[QUELLEN]]\n1|awmf.org|2023|S3\n2|erfunden.de|2024|x\n3|dgn.org|2023|DGN',
        ['awmf.org', 'dgn.org'],
      ),
    ]);

    const { content: out } = await invokeTool(toolWith(search));

    expect(out).toContain('A gilt. B gilt. C gilt.');
    expect(out).toMatch(/1\. \[awmf\.org\]\([^)]*\)[^\n]*\n2\. \[dgn\.org\]/);
    expect(out).not.toContain('erfunden.de');
    expect(out).toMatch(/1 zitierte Quelle wurde entfernt/);
  });

  test('lists weak sources rather than refusing', async () => {
    const search = stubModel([
      groundedResponse('Belastbare Evidenz fehlt [1].\n[[QUELLEN]]\n1|netdoktor.de|2022|Portal', [
        'netdoktor.de',
      ]),
    ]);

    const { content: out } = await invokeTool(toolWith(search));

    expect(out).toContain('Belastbare Evidenz fehlt.');
    expect(out).toContain('[netdoktor.de](');
    expect(out).not.toMatch(/verifiziert/);
  });

  test('keeps only the unnamed search results the answer is attributed to', async () => {
    const search = stubModel([
      groundedResponse(
        'Bis 4,5 h.\n[[QUELLEN]]\n1|awmf.org|2023|S2e',
        ['awmf.org', 'dgn.org', 'aok.de'],
        [[0], [1]],
      ),
    ]);

    const { content: out } = await invokeTool(toolWith(search));

    expect(out).toContain('[dgn.org](');
    expect(out).not.toContain('aok.de');
  });

  test('reports a failed search as a message instead of throwing', async () => {
    const search = stubModel([new Error('503 Service Unavailable')]);

    const { content: out } = await invokeTool(toolWith(search));

    expect(out).toMatch(/error with the Web Grounding for Enterprise Search/);
  });
});

describe('WebGroundingEnterprise client wiring', () => {
  const saved = { ...process.env };
  let dir;

  beforeEach(() => {
    mockClients.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wge-'));
    const key = path.join(dir, 'key.json');
    const policy = path.join(dir, 'policy.json');
    fs.writeFileSync(
      key,
      JSON.stringify({
        project_id: 'uksh-pub-dev-genai-portal',
        client_email: 'sa@x',
        private_key: 'k',
      }),
    );
    fs.writeFileSync(policy, JSON.stringify({ excludeDomains: ['junk.example'] }));
    process.env.GOOGLE_LOC = 'eu';
    process.env.GOOGLE_SERVICE_KEY_FILE = key;
    process.env.WEB_GROUNDING_SOURCES_FILE = policy;
    delete process.env.WEB_GROUNDING_MODEL;
    delete process.env.WEB_GROUNDING_THINKING_LEVEL;
  });

  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('runs the search on the agent model through one client on the PSC endpoint', () => {
    new WebGroundingEnterprise({ geminiModel: 'gemini-3.8-flash' });

    expect(mockClients).toHaveLength(1);
    expect(mockClients[0].options.apiEndpoint).toBe('aiplatform.eu.rep.googleapis.com');
    expect(mockClients[0].models).toEqual([
      {
        model: 'gemini-3.8-flash',
        tools: [{ enterpriseWebSearch: { excludeDomains: ['junk.example'] } }],
      },
    ]);
  });

  test('lets an explicit model override replace the agent model', () => {
    process.env.WEB_GROUNDING_MODEL = 'gemini-3.5-flash-lite';

    new WebGroundingEnterprise({ geminiModel: 'gemini-3.8-flash' });

    expect(mockClients[0].models.map((m) => m.model)).toEqual(['gemini-3.5-flash-lite']);
  });

  test('sets the thinking level of the search model when one is configured', () => {
    process.env.WEB_GROUNDING_MODEL = 'gemini-3.5-flash';
    process.env.WEB_GROUNDING_THINKING_LEVEL = 'LOW';

    new WebGroundingEnterprise({ geminiModel: 'gemini-3.8-flash' });

    expect(mockClients[0].models).toEqual([
      {
        model: 'gemini-3.5-flash',
        tools: [{ enterpriseWebSearch: { excludeDomains: ['junk.example'] } }],
        generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
      },
    ]);
  });
});
