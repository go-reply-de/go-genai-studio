import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AppConfig } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { TranscribeRequest, VertexClient } from './transcribe';
import {
  createTranscribeServer,
  getTranscribeTarget,
  startTranscribeService,
  transcribeWithGemini,
} from './transcribe';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  jest.clearAllMocks();
});

function sttConfig(url: string, apiKey = 'local'): AppConfig {
  return {
    speech: { stt: { openai: { url, apiKey, model: 'gemini-3.5-transcribe' } } },
  } as AppConfig;
}

function vertexReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function upload(fields: {
  file?: Blob;
  name?: string;
  model?: string;
  language?: string;
}): FormData {
  const form = new FormData();
  if (fields.file) form.append('file', fields.file, fields.name ?? 'audio.webm');
  form.append('model', fields.model ?? 'gemini-3.5-transcribe');
  if (fields.language) form.append('language', fields.language);
  return form;
}

describe('getTranscribeTarget', () => {
  it('returns the port, path and key when the STT url points at 127.0.0.1', () => {
    const target = getTranscribeTarget(sttConfig('http://127.0.0.1:3081/v1/audio/transcriptions'));
    expect(target).toEqual({ port: 3081, path: '/v1/audio/transcriptions', apiKey: 'local' });
  });

  it('ignores an STT url on another host', () => {
    expect(
      getTranscribeTarget(sttConfig('https://api.openai.com/v1/audio/transcriptions')),
    ).toBeNull();
  });

  it('returns null without an STT config', () => {
    expect(getTranscribeTarget({} as AppConfig)).toBeNull();
    expect(getTranscribeTarget(undefined)).toBeNull();
  });

  it('resolves a key the config takes from the environment, as the STT upload does', () => {
    process.env.STT_LOOPBACK_KEY = 'from-env';
    const target = getTranscribeTarget(
      sttConfig('http://127.0.0.1:3081/v1/audio/transcriptions', '${STT_LOOPBACK_KEY}'),
    );
    expect(target?.apiKey).toBe('from-env');
  });

  it('returns null without a key, so the listener never accepts an unauthenticated upload', () => {
    expect(
      getTranscribeTarget(sttConfig('http://127.0.0.1:3081/v1/audio/transcriptions', '')),
    ).toBeNull();
  });
});

describe('transcribeWithGemini', () => {
  const input: TranscribeRequest = {
    audio: Buffer.from('abc'),
    mimeType: 'audio/webm',
    model: 'gemini-3.5-transcribe',
    language: 'de',
  };

  function client(reply: Response, location = 'eu') {
    const fetchMock = jest.fn().mockResolvedValue(reply);
    const vertex: VertexClient = {
      project: 'synthetic-project',
      location,
      getToken: async () => 'synthetic-token',
      fetch: fetchMock,
    };
    return { vertex, fetchMock };
  }

  it('sends the audio to the multi-region endpoint and returns the transcript', async () => {
    const { vertex, fetchMock } = client(
      vertexReply({ candidates: [{ content: { parts: [{ text: 'Metoprolol 47,5 mg ' }] } }] }),
    );

    const text = await transcribeWithGemini(input, vertex);

    expect(text).toBe('Metoprolol 47,5 mg');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://aiplatform.eu.rep.googleapis.com/v1/projects/synthetic-project/locations/eu/publishers/google/models/gemini-3.5-transcribe:generateContent',
    );
    expect(init.headers.Authorization).toBe('Bearer synthetic-token');
    expect(JSON.parse(init.body)).toEqual({
      contents: [
        { role: 'user', parts: [{ inlineData: { mimeType: 'audio/webm', data: 'YWJj' } }] },
      ],
      generationConfig: { audioTranscriptionConfig: { mode: 'VERBATIM', languageCodes: ['de'] } },
    });
  });

  it('lets the model detect the language when the client sends none', async () => {
    const { vertex, fetchMock } = client(vertexReply({ candidates: [] }));

    await transcribeWithGemini({ ...input, language: undefined }, vertex);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.audioTranscriptionConfig).toEqual({ mode: 'VERBATIM' });
  });

  it('uses the global host for the global location', async () => {
    const { vertex, fetchMock } = client(vertexReply({ candidates: [] }), 'global');

    await transcribeWithGemini(input, vertex);

    expect(fetchMock.mock.calls[0][0]).toMatch(
      /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/synthetic-project\/locations\/global\//,
    );
  });

  it('returns an empty transcript when the model hears no speech', async () => {
    const { vertex } = client(vertexReply({ candidates: [{ finishReason: 'STOP' }] }));
    await expect(transcribeWithGemini(input, vertex)).resolves.toBe('');
  });

  it('fails with the status when Vertex refuses the request', async () => {
    const { vertex } = client(vertexReply({ error: { message: 'Resource exhausted' } }, 429));
    await expect(transcribeWithGemini(input, vertex)).rejects.toThrow('429');
  });
});

describe('createTranscribeServer', () => {
  const target = { port: 0, path: '/v1/audio/transcriptions', apiKey: 'local' };
  let server: http.Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function start(transcribe: jest.Mock, options?: { maxBytes?: number }): Promise<string> {
    server = createTranscribeServer(target, transcribe, options);
    const port = await listen(server);
    return `http://127.0.0.1:${port}`;
  }

  it('answers an OpenAI-style upload with the transcript', async () => {
    const transcribe = jest.fn().mockResolvedValue('Pantoprazol 40 mg');
    const base = await start(transcribe);

    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: upload({ file: new Blob(['abc'], { type: 'audio/webm' }), language: 'de' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Pantoprazol 40 mg' });
    expect(transcribe).toHaveBeenCalledWith({
      audio: Buffer.from('abc'),
      mimeType: 'audio/webm',
      model: 'gemini-3.5-transcribe',
      language: 'de',
    });
  });

  it('takes the audio type from the file name when the part has none', async () => {
    const transcribe = jest.fn().mockResolvedValue('');
    const base = await start(transcribe);

    await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: upload({ file: new Blob(['abc']), name: 'audio.wav' }),
    });

    expect(transcribe.mock.calls[0][0].mimeType).toBe('audio/wav');
  });

  it('sends webm as audio when the upload labels it video/webm, as the STT upload does', async () => {
    const transcribe = jest.fn().mockResolvedValue('');
    const base = await start(transcribe);

    await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: upload({ file: new Blob(['abc'], { type: 'video/webm' }), name: 'audio.webm' }),
    });

    expect(transcribe.mock.calls[0][0].mimeType).toBe('audio/webm');
  });

  it('refuses a request without the configured key', async () => {
    const transcribe = jest.fn();
    const base = await start(transcribe);

    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer other' },
      body: upload({ file: new Blob(['abc'], { type: 'audio/webm' }) }),
    });

    expect(res.status).toBe(401);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('refuses other paths', async () => {
    const base = await start(jest.fn());
    const res = await fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer local' } });
    expect(res.status).toBe(404);
  });

  it('refuses an upload above the size limit', async () => {
    const transcribe = jest.fn();
    const base = await start(transcribe, { maxBytes: 1024 });

    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: upload({ file: new Blob([Buffer.alloc(4096)], { type: 'audio/webm' }) }),
    });

    expect(res.status).toBe(413);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('answers 400 when the upload has no audio file', async () => {
    const base = await start(jest.fn());

    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: upload({}),
    });

    expect(res.status).toBe(400);
  });

  it('reports a failed transcription as 502', async () => {
    const base = await start(jest.fn().mockRejectedValue(new Error('Vertex answered 429')));

    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: upload({ file: new Blob(['abc'], { type: 'audio/webm' }) }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { message: 'Transcription failed' } });
  });
});

describe('startTranscribeService', () => {
  let keyDir: string;

  beforeEach(() => {
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-key-'));
    const keyFile = path.join(keyDir, 'key.json');
    fs.writeFileSync(
      keyFile,
      JSON.stringify({
        type: 'service_account',
        project_id: 'synthetic-project',
        client_email: 'synthetic@synthetic-project.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n',
      }),
    );
    process.env.GOOGLE_SERVICE_KEY_FILE = keyFile;
  });

  afterEach(() => fs.rmSync(keyDir, { recursive: true, force: true }));

  it('listens on the loopback port from the STT url', async () => {
    process.env.GOOGLE_LOC = 'eu';
    const port = await freePort();

    const server = await startTranscribeService(
      sttConfig(`http://127.0.0.1:${port}/v1/audio/transcriptions`),
    );

    try {
      expect(server).not.toBeNull();
      const res = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  it('stays off when the STT url points elsewhere', async () => {
    process.env.GOOGLE_LOC = 'eu';
    await expect(
      startTranscribeService(sttConfig('https://api.openai.com/v1/audio/transcriptions')),
    ).resolves.toBeNull();
  });

  it('stays off when the port is taken, so the api still starts', async () => {
    process.env.GOOGLE_LOC = 'eu';
    const taken = http.createServer();
    const port = await listen(taken);

    try {
      await expect(
        startTranscribeService(sttConfig(`http://127.0.0.1:${port}/v1/audio/transcriptions`)),
      ).resolves.toBeNull();
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });

  it('stays off when GOOGLE_LOC is a single region, where the model is not served', async () => {
    process.env.GOOGLE_LOC = 'europe-west3';
    const port = await freePort();
    await expect(
      startTranscribeService(sttConfig(`http://127.0.0.1:${port}/v1/audio/transcriptions`)),
    ).resolves.toBeNull();
  });
});
