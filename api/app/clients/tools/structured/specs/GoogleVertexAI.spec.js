const fs = require('fs');
const os = require('os');
const path = require('path');

const mockModels = [];
jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: jest.fn().mockImplementation(() => ({
    preview: {
      getGenerativeModel: (params, requestOptions) => {
        const model = { params, requestOptions, generateContent: jest.fn() };
        mockModels.push(model);
        return model;
      },
    },
  })),
}));

const GoogleVertexAI = require('../GoogleVertexAI');

const DATASTORE = 'projects/p/locations/eu/collections/default_collection/dataStores/d';
const env = { ...process.env };
let keyDir;

const groundedResponse = (text) => ({
  response: {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        groundingMetadata: {
          groundingChunks: [{ retrievedContext: { uri: 'gs://bucket/doc.docx', title: 'Doc' } }],
        },
      },
    ],
  },
});

/** The SDK's shape for a request it aborted after its timeout. */
const timeoutError = () =>
  Object.assign(new Error('exception posting request to model'), {
    name: 'GoogleGenerativeAIError',
    cause: Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
  });

const buildTool = (geminiModel = 'gemini-3.5-flash') => {
  const tool = new GoogleVertexAI({
    isAgent: true,
    geminiModel,
    VERTEX_AI_DATASTORE_ID: DATASTORE,
  });
  return { tool, model: mockModels[mockModels.length - 1] };
};

beforeAll(() => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-search-key-'));
  const keyFile = path.join(keyDir, 'auth.json');
  fs.writeFileSync(
    keyFile,
    JSON.stringify({ project_id: 'test-project', client_email: 'sa@test', private_key: 'x' }),
  );
  process.env.GOOGLE_SERVICE_KEY_FILE = keyFile;
  process.env.GOOGLE_LOC = 'europe-west3';
});

afterAll(() => {
  process.env = env;
  fs.rmSync(keyDir, { recursive: true, force: true });
});

describe('GoogleVertexAI', () => {
  it('searches with LOW thinking, the fact-list instruction and a per-try timeout', () => {
    const { model } = buildTool();
    expect(model.params.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: 'LOW' } });
    expect(model.params.systemInstruction).toMatch(/compact bulleted list/);
    expect(model.params.tools[0].retrieval.vertexAiSearch.datastore).toBe(DATASTORE);
    expect(model.requestOptions).toEqual({ timeout: 60000 });
  });

  it('leaves the thinking default of models before Gemini 3', () => {
    const { model } = buildTool('gemini-2.5-flash');
    expect(model.params.generationConfig).toBeUndefined();
  });

  it('retries a try that timed out and returns the answer with its sources', async () => {
    const { tool, model } = buildTool();
    model.generateContent
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(groundedResponse('- Hagenow liegt in Mecklenburg.'));

    const answer = await tool._call({ query: 'Hagenow' });

    expect(model.generateContent).toHaveBeenCalledTimes(2);
    expect(answer).toContain('- Hagenow liegt in Mecklenburg.');
    expect(answer).toContain('gs://bucket/doc.docx');
  }, 10000);

  it('does not retry a rejected request', async () => {
    const { tool, model } = buildTool();
    model.generateContent.mockRejectedValueOnce(
      Object.assign(new Error('bad request'), { response: { status: 400 } }),
    );

    await expect(tool._call({ query: 'Hagenow' })).resolves.toBe(
      'There was an error with Vertex AI Search.',
    );
    expect(model.generateContent).toHaveBeenCalledTimes(1);
  });
});
