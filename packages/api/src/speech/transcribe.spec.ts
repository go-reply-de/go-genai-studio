import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import type { AppConfig } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import type { VertexLiveEvents, VertexLiveStream } from './vertexLive';
import type { TranscribeEndpointOptions } from './transcribe';
import {
  TRANSCRIBE_PATH,
  createTranscribeEndpoint,
  getTranscribeModel,
  startTranscribeService,
} from './transcribe';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const ORIGIN = 'https://studio.example';
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  jest.clearAllMocks();
});

function sttConfig(url: string, model = 'gemini-3.5-transcribe-live'): AppConfig {
  return { speech: { stt: { openai: { url, apiKey: 'loopback', model } } } } as AppConfig;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Message = { type: string; text?: string; code?: string };

const last = (messages: Message[]) => messages[messages.length - 1];

interface Client {
  socket: WebSocket;
  messages: Message[];
  closed: Promise<number>;
}

const openSockets: WebSocket[] = [];

function closeSockets() {
  openSockets.splice(0).forEach((socket) => socket.terminate());
}

function connect(port: number, origin = ORIGIN, urlPath = TRANSCRIBE_PATH): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, { origin });
    openSockets.push(socket);
    const messages: Message[] = [];
    const closed = new Promise<number>((done) => socket.on('close', (code) => done(code)));
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    socket.once('open', () => resolve({ socket, messages, closed }));
    socket.once('error', reject);
  });
}

function start(client: Client, token = 'good-token', language?: string) {
  client.socket.send(JSON.stringify({ type: 'start', token, ...(language && { language }) }));
}

describe('getTranscribeModel', () => {
  it('returns the model when the STT url points at 127.0.0.1', () => {
    expect(getTranscribeModel(sttConfig('http://127.0.0.1:3081/v1/audio/transcriptions'))).toBe(
      'gemini-3.5-transcribe-live',
    );
  });

  it('returns null for an STT url on another host', () => {
    expect(
      getTranscribeModel(sttConfig('https://api.openai.com/v1/audio/transcriptions')),
    ).toBeNull();
  });

  it('returns null without an STT config', () => {
    expect(getTranscribeModel({} as AppConfig)).toBeNull();
    expect(getTranscribeModel(undefined)).toBeNull();
  });
});

describe('transcribe endpoint', () => {
  let server: http.Server;
  let port: number;
  let vertex: { events: VertexLiveEvents; stream: jest.Mocked<VertexLiveStream> } | undefined;
  let openStream: jest.Mock;

  async function listen(overrides: Partial<TranscribeEndpointOptions> = {}) {
    server = http.createServer();
    createTranscribeEndpoint({
      openStream,
      verifyUser: (token) => (token === 'good-token' ? 'user-1' : null),
      allowedOrigin: ORIGIN,
      ...overrides,
    })(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }

  async function readyClient(language?: string): Promise<Client> {
    const client = await connect(port);
    start(client, 'good-token', language);
    await until(() => vertex != null);
    vertex?.events.onReady();
    await until(() => client.messages.some((m) => m.type === 'ready'));
    return client;
  }

  beforeEach(() => {
    vertex = undefined;
    openStream = jest.fn(async (_language: string | undefined, events: VertexLiveEvents) => {
      const stream = { send: jest.fn(), end: jest.fn(), close: jest.fn() };
      vertex = { events, stream };
      return stream;
    });
  });

  afterEach(async () => {
    closeSockets();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('streams a dictation and finishes once stopped', async () => {
    await listen();
    const client = await readyClient('de-DE');
    expect(openStream.mock.calls[0][0]).toBe('de-DE');

    client.socket.send(Buffer.from([1, 2, 3, 4]));
    await until(() => (vertex?.stream.send.mock.calls.length ?? 0) > 0);
    expect(vertex?.stream.send).toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]));

    vertex?.events.onSpeech(true);
    vertex?.events.onInterim('Apixaban');
    vertex?.events.onFinal('Apixaban 5 mg.');
    vertex?.events.onSpeech(false);
    client.socket.send(JSON.stringify({ type: 'stop' }));

    expect(await client.closed).toBe(1000);
    expect(client.messages).toEqual([
      { type: 'ready' },
      { type: 'interim', text: 'Apixaban' },
      { type: 'final', text: 'Apixaban 5 mg.' },
      { type: 'done' },
    ]);
    expect(vertex?.stream.end).toHaveBeenCalled();
    expect(vertex?.stream.close).toHaveBeenCalled();
  });

  it('waits for the speech to end before it finishes a stopped dictation', async () => {
    await listen();
    const client = await readyClient();

    vertex?.events.onSpeech(true);
    client.socket.send(JSON.stringify({ type: 'stop' }));
    await until(() => (vertex?.stream.end.mock.calls.length ?? 0) > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.messages.map((m) => m.type)).toEqual(['ready']);

    vertex?.events.onFinal('Kein Fieber.');
    vertex?.events.onSpeech(false);

    expect(await client.closed).toBe(1000);
    expect(client.messages.slice(1)).toEqual([
      { type: 'final', text: 'Kein Fieber.' },
      { type: 'done' },
    ]);
  });

  it('finishes a stopped dictation after the stop timeout if speech never ends', async () => {
    await listen({ stopTimeoutMs: 30 });
    const client = await readyClient();

    vertex?.events.onSpeech(true);
    client.socket.send(JSON.stringify({ type: 'stop' }));

    expect(await client.closed).toBe(1000);
    expect(last(client.messages)).toEqual({ type: 'done' });
  });

  it('ends a session at the time limit', async () => {
    await listen({ maxSessionMs: 30 });
    const client = await readyClient();

    expect(await client.closed).toBe(1000);
    expect(last(client.messages)).toEqual({ type: 'done' });
    expect(vertex?.stream.end).toHaveBeenCalled();
  });

  it('ignores audio that arrives before Vertex AI is ready', async () => {
    await listen();
    const client = await connect(port);
    start(client);
    await until(() => vertex != null);

    client.socket.send(Buffer.from([1, 2]));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(vertex?.stream.send).not.toHaveBeenCalled();
  });

  it('passes only language tags on to Vertex AI', async () => {
    await listen();
    const client = await connect(port);
    start(client, 'good-token', 'de-DE"; drop');
    await until(() => vertex != null);

    expect(openStream.mock.calls[0][0]).toBeUndefined();
  });

  it('refuses a session with an invalid token', async () => {
    await listen();
    const client = await connect(port);
    start(client, 'forged-token');

    expect(await client.closed).toBe(1008);
    expect(client.messages).toEqual([{ type: 'error', code: 'unauthorized' }]);
    expect(openStream).not.toHaveBeenCalled();
  });

  it('closes a session that never starts', async () => {
    await listen({ startTimeoutMs: 30 });
    const client = await connect(port);

    expect(await client.closed).toBe(1008);
    expect(client.messages).toEqual([{ type: 'error', code: 'bad_request' }]);
  });

  it('allows two sessions per user, for the hand-over between them, and refuses a third', async () => {
    await listen();
    const clients = [await connect(port), await connect(port), await connect(port)];
    clients.forEach((client) => start(client));

    await until(() => clients[2].messages.length > 0);

    expect(clients[2].messages).toEqual([{ type: 'error', code: 'busy' }]);
    expect(openStream).toHaveBeenCalledTimes(2);
  });

  it('reports Vertex AI failing during a dictation', async () => {
    await listen();
    const client = await readyClient();

    vertex?.events.onClose(new Error('Vertex AI closed 1011'));

    expect(await client.closed).toBe(1011);
    expect(last(client.messages)).toEqual({ type: 'error', code: 'unavailable' });
  });

  it('reports a Vertex AI session that cannot be opened', async () => {
    openStream.mockRejectedValueOnce(new Error('no token'));
    await listen();
    const client = await connect(port);
    start(client);

    expect(await client.closed).toBe(1011);
    expect(client.messages).toEqual([{ type: 'error', code: 'unavailable' }]);
  });

  it('closes the Vertex AI session when the browser disconnects', async () => {
    await listen();
    const client = await readyClient();

    client.socket.terminate();
    await until(() => (vertex?.stream.close.mock.calls.length ?? 0) > 0);

    expect(vertex?.stream.close).toHaveBeenCalledTimes(1);
  });

  it('refuses a connection from another origin', async () => {
    await listen();
    await expect(connect(port, 'https://attacker.example')).rejects.toThrow('403');
  });

  it('leaves other paths alone', async () => {
    await listen();
    await expect(connect(port, ORIGIN, '/api/other')).rejects.toThrow();
  });
});

describe('startTranscribeService', () => {
  let keyDir: string;
  let server: http.Server | undefined;

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
    process.env.GOOGLE_LOC = 'eu';
    process.env.JWT_SECRET = 'synthetic-secret';
    process.env.DOMAIN_CLIENT = `${ORIGIN}/`;
  });

  afterEach(async () => {
    fs.rmSync(keyDir, { recursive: true, force: true });
    closeSockets();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
  });

  it('adds the endpoint to the server the app starts', async () => {
    const app = express();
    await expect(
      startTranscribeService(app, sttConfig('http://127.0.0.1:3081/v1/audio/transcriptions')),
    ).resolves.toBe(true);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server?.once('listening', resolve));
    const client = await connect((server.address() as AddressInfo).port);
    start(client, 'forged-token');

    expect(await client.closed).toBe(1008);
    expect(client.messages).toEqual([{ type: 'error', code: 'unauthorized' }]);
  });

  it('stays off when the STT url points elsewhere', async () => {
    const app = express();
    const listen = app.listen;

    await expect(
      startTranscribeService(app, sttConfig('https://api.openai.com/v1/audio/transcriptions')),
    ).resolves.toBe(false);
    expect(app.listen).toBe(listen);
  });

  it('stays off when GOOGLE_LOC is a single region, where the model is not served', async () => {
    process.env.GOOGLE_LOC = 'europe-west3';
    await expect(
      startTranscribeService(express(), sttConfig('http://127.0.0.1:3081/v1/audio/transcriptions')),
    ).resolves.toBe(false);
  });

  it('stays off without a JWT secret to check sessions against', async () => {
    delete process.env.JWT_SECRET;
    await expect(
      startTranscribeService(express(), sttConfig('http://127.0.0.1:3081/v1/audio/transcriptions')),
    ).resolves.toBe(false);
  });
});
