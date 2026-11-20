const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(async () => ({
    VERTEX_AI_DATASTORE_ID: 'projects/p/locations/eu/collections/c/dataStores/d',
  })),
}));

const { vertexToolConstructors } = require('./vertexTools');

const getAuthFields = () => ['VERTEX_AI_DATASTORE_ID'];
const env = { ...process.env };
let keyDir;

beforeAll(() => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-key-'));
  const keyFile = path.join(keyDir, 'auth.json');
  fs.writeFileSync(
    keyFile,
    JSON.stringify({ type: 'service_account', project_id: 'test-project', private_key: 'x' }),
  );
  process.env.GOOGLE_SERVICE_KEY_FILE = keyFile;
  process.env.GOOGLE_LOC = 'europe-west3';
});

afterAll(() => {
  process.env = env;
  fs.rmSync(keyDir, { recursive: true, force: true });
});

describe('vertexToolConstructors', () => {
  it('builds Vertex AI Search for an agent', async () => {
    const tool = await vertexToolConstructors({
      user: 'user',
      agent: { model: 'gemini-3.5-flash' },
      options: {},
      getAuthFields,
    }).vertex_ai_search();
    expect(tool.name).toBe('vertex_ai_search');
  });

  it('refuses Vertex AI Search outside an agent', async () => {
    await expect(
      vertexToolConstructors({ user: 'user', options: {}, getAuthFields }).vertex_ai_search(),
    ).rejects.toThrow('only available for agents');
  });
});
