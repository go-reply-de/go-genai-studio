import { WebSocketServer } from 'ws';
import type { IncomingHttpHeaders } from 'http';
import type { AddressInfo } from 'net';
import type WebSocket from 'ws';
import type { VertexLiveEvents, VertexLiveOptions } from './vertexLive';
import { openVertexLive, vertexLiveUrl } from './vertexLive';

type Connection = { socket: WebSocket; headers: IncomingHttpHeaders };

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function events(): jest.Mocked<VertexLiveEvents> {
  return {
    onReady: jest.fn(),
    onInterim: jest.fn(),
    onFinal: jest.fn(),
    onSpeech: jest.fn(),
    onClose: jest.fn(),
  };
}

describe('vertexLiveUrl', () => {
  it('uses the multi-region host of the location', () => {
    expect(vertexLiveUrl('eu')).toBe(
      'wss://aiplatform.eu.rep.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent',
    );
    expect(vertexLiveUrl('global')).toBe(
      'wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent',
    );
  });
});

describe('openVertexLive', () => {
  let server: WebSocketServer;
  let connected: Promise<Connection>;
  let options: VertexLiveOptions;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    connected = new Promise((resolve) =>
      server.once('connection', (socket, req) => resolve({ socket, headers: req.headers })),
    );
    const { port } = server.address() as AddressInfo;
    options = {
      project: 'synthetic-project',
      location: 'eu',
      model: 'gemini-3.5-transcribe-live',
      language: 'de-DE',
      getToken: async () => 'synthetic-token',
      url: `ws://127.0.0.1:${port}`,
    };
  });

  afterEach(async () => {
    server.clients.forEach((client) => client.terminate());
    await new Promise((resolve) => server.close(resolve));
  });

  function nextMessage(socket: WebSocket): Promise<unknown> {
    return new Promise((resolve) =>
      socket.once('message', (data) => resolve(JSON.parse(data.toString()))),
    );
  }

  async function readySession(overrides: Partial<VertexLiveOptions> = {}) {
    const handlers = events();
    const stream = await openVertexLive({ ...options, ...overrides }, handlers);
    const { socket, headers } = await connected;
    const setup = await nextMessage(socket);
    socket.send(JSON.stringify({ setupComplete: {} }));
    await until(() => handlers.onReady.mock.calls.length > 0);
    return { handlers, stream, socket, headers, setup };
  }

  it('sets up a transcription-only session with the bearer token', async () => {
    const { headers, setup } = await readySession();

    expect(headers.authorization).toBe('Bearer synthetic-token');
    expect(setup).toEqual({
      setup: {
        model:
          'projects/synthetic-project/locations/eu/publishers/google/models/gemini-3.5-transcribe-live',
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { mode: 'VERBATIM', languageCodes: ['de-DE'] },
      },
    });
  });

  it('lets the model detect the language when none is given', async () => {
    const { setup } = await readySession({ language: undefined });
    expect((setup as { setup: Record<string, unknown> }).setup.inputAudioTranscription).toEqual({
      mode: 'VERBATIM',
    });
  });

  it('reports interim and final text and when speech starts and ends', async () => {
    const { handlers, socket } = await readySession();

    socket.send(JSON.stringify({ voiceActivity: { type: 'ACTIVITY_START' } }));
    socket.send(
      JSON.stringify({ serverContent: { interimInputTranscription: { text: 'Apixaban' } } }),
    );
    socket.send(
      JSON.stringify({ serverContent: { inputTranscription: { text: 'Apixaban 5 mg.' } } }),
    );
    socket.send(JSON.stringify({ voiceActivity: { type: 'ACTIVITY_END' } }));
    await until(() => handlers.onSpeech.mock.calls.length === 2);

    expect(handlers.onInterim).toHaveBeenCalledWith('Apixaban');
    expect(handlers.onFinal).toHaveBeenCalledWith('Apixaban 5 mg.');
    expect(handlers.onSpeech.mock.calls).toEqual([[true], [false]]);
  });

  it('streams audio as 16 kHz PCM and ends the audio stream', async () => {
    const { stream, socket } = await readySession();

    const audio = nextMessage(socket);
    stream.send(Buffer.from([1, 2, 3, 4]));
    expect(await audio).toEqual({
      realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: 'AQIDBA==' } },
    });

    const end = nextMessage(socket);
    stream.end();
    expect(await end).toEqual({ realtimeInput: { audioStreamEnd: true } });
  });

  it('reports a session Vertex AI refuses as an error', async () => {
    const { handlers, socket } = await readySession();

    socket.close(1008, 'Invalid model');
    await until(() => handlers.onClose.mock.calls.length > 0);

    expect(handlers.onClose.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('reports a session it closes itself without an error', async () => {
    const { handlers, stream } = await readySession();

    stream.close();
    await until(() => handlers.onClose.mock.calls.length > 0);

    expect(handlers.onClose).toHaveBeenCalledWith(undefined);
  });
});
