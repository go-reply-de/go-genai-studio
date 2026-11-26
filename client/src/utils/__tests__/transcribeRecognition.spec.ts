import type {
  Microphone,
  RecognitionResultEvent,
  TranscribeRecognitionDeps,
} from '../transcribeRecognition';
import { createTranscribeRecognition } from '../transcribeRecognition';

type ServerMessage = { type: string; text?: string; code?: string };

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  json() {
    return this.sent.filter((data) => typeof data === 'string').map((data) => JSON.parse(data));
  }

  audio() {
    return this.sent.filter((data) => typeof data !== 'string');
  }
}

const chunk = (value: number) => new Int16Array([value]).buffer;
/** Settles pending promises; works with fake timers too. */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

let pushAudio: (pcm: ArrayBuffer) => void;
let microphone: jest.Mocked<Microphone>;
let deps: TranscribeRecognitionDeps & {
  refreshToken: jest.Mock<Promise<void>, []>;
  openMicrophone: jest.Mock<Promise<Microphone>, [(pcm: ArrayBuffer) => void]>;
  onFailure: jest.Mock;
};
let token: string;

function recognition() {
  const Recognition = createTranscribeRecognition(deps);
  const instance = new Recognition();
  instance.lang = 'de-DE';
  instance.onresult = jest.fn();
  instance.onend = jest.fn();
  instance.onerror = jest.fn();
  return instance as typeof instance & {
    onresult: jest.Mock<void, [RecognitionResultEvent]>;
    onend: jest.Mock;
    onerror: jest.Mock;
  };
}

function texts(onresult: jest.Mock<void, [RecognitionResultEvent]>) {
  return onresult.mock.calls.map(([event]) => {
    const result = event.results[event.resultIndex];
    return `${result.isFinal ? 'final' : 'interim'}: ${result[0].transcript}`;
  });
}

async function readySocket(index = 0) {
  await flush();
  const socket = FakeSocket.instances[index];
  socket.open();
  socket.receive({ type: 'ready' });
  return socket;
}

beforeEach(() => {
  FakeSocket.instances = [];
  token = 'synthetic-token';
  microphone = { stop: jest.fn() };
  deps = {
    url: () => 'wss://studio.example/api/speech/transcribe',
    getToken: () => token,
    refreshToken: jest.fn(async () => {
      token = 'fresh-token';
    }),
    openMicrophone: jest.fn(async (onChunk: (pcm: ArrayBuffer) => void) => {
      pushAudio = onChunk;
      return microphone;
    }),
    createSocket: (url: string) => new FakeSocket(url) as unknown as WebSocket,
    onFailure: jest.fn(),
    handoverMs: 240_000,
    handoverGraceMs: 40_000,
    stopTimeoutMs: 8_000,
  };
});

afterEach(() => jest.useRealTimers());

describe('TranscribeRecognition', () => {
  it('streams microphone audio once the session is ready and shows the text as it grows', async () => {
    const speech = recognition();
    speech.start();
    await flush();
    const socket = FakeSocket.instances[0];
    socket.open();

    expect(socket.url).toBe('wss://studio.example/api/speech/transcribe');
    expect(socket.json()).toEqual([{ type: 'start', token: 'synthetic-token', language: 'de-DE' }]);

    pushAudio(chunk(1));
    expect(socket.audio()).toHaveLength(0);
    socket.receive({ type: 'ready' });
    pushAudio(chunk(2));
    expect(socket.audio()).toEqual([chunk(1), chunk(2)]);

    socket.receive({ type: 'interim', text: 'Apixaban' });
    socket.receive({ type: 'final', text: 'Apixaban 5 mg.' });
    socket.receive({ type: 'interim', text: 'Rücksprache' });

    expect(texts(speech.onresult)).toEqual([
      'interim: Apixaban',
      'interim: Apixaban 5 mg.',
      'interim: Apixaban 5 mg. Rücksprache',
    ]);
    expect(speech.onend).not.toHaveBeenCalled();
  });

  it('delivers the whole text as one final result once the server confirms the stop', async () => {
    const speech = recognition();
    speech.start();
    const socket = await readySocket();
    socket.receive({ type: 'final', text: 'Apixaban 5 mg.' });

    speech.stop();
    expect(microphone.stop).toHaveBeenCalled();
    expect(socket.json().at(-1)).toEqual({ type: 'stop' });
    expect(speech.onend).not.toHaveBeenCalled();

    socket.receive({ type: 'final', text: 'Rücksprache erfolgt.' });
    socket.receive({ type: 'done' });

    expect(texts(speech.onresult).at(-1)).toBe('final: Apixaban 5 mg. Rücksprache erfolgt.');
    expect(speech.onend).toHaveBeenCalledTimes(1);
  });

  it('ends without a result when nothing was said', async () => {
    const speech = recognition();
    speech.start();
    const socket = await readySocket();

    speech.stop();
    socket.receive({ type: 'done' });

    expect(speech.onresult).not.toHaveBeenCalled();
    expect(speech.onend).toHaveBeenCalledTimes(1);
    expect(speech.onerror).not.toHaveBeenCalled();
  });

  it('sends audio recorded before the session was ready, then the stop', async () => {
    const speech = recognition();
    speech.start();
    await flush();
    const socket = FakeSocket.instances[0];
    socket.open();
    pushAudio(chunk(1));

    speech.stop();
    expect(socket.json()).toEqual([expect.objectContaining({ type: 'start' })]);

    socket.receive({ type: 'ready' });
    expect(socket.audio()).toEqual([chunk(1)]);
    expect(socket.json().at(-1)).toEqual({ type: 'stop' });
  });

  it('hands over to a new session at the end of a sentence, before the load balancer closes the old one', async () => {
    jest.useFakeTimers();
    const speech = recognition();
    speech.start();
    const first = await readySocket(0);
    first.receive({ type: 'interim', text: 'Erster' });

    jest.advanceTimersByTime(240_000);
    expect(FakeSocket.instances).toHaveLength(1);

    first.receive({ type: 'final', text: 'Erster Teil.' });
    expect(first.json().at(-1)).toEqual({ type: 'stop' });
    const second = FakeSocket.instances[1];
    second.open();
    pushAudio(chunk(3));
    expect(second.audio()).toHaveLength(0);
    second.receive({ type: 'ready' });
    expect(second.audio()).toEqual([chunk(3)]);
    expect(first.audio()).toHaveLength(0);

    second.receive({ type: 'interim', text: 'zweiter' });
    first.receive({ type: 'done' });
    expect(texts(speech.onresult).at(-1)).toBe('interim: Erster Teil. zweiter');
    expect(speech.onend).not.toHaveBeenCalled();

    speech.stop();
    second.receive({ type: 'final', text: 'zweiter Teil.' });
    second.receive({ type: 'done' });

    expect(texts(speech.onresult).at(-1)).toBe('final: Erster Teil. zweiter Teil.');
    expect(speech.onend).toHaveBeenCalledTimes(1);
  });

  it('hands over in a pause in the audio when no sentence has ended', async () => {
    jest.useFakeTimers();
    const speech = recognition();
    speech.start();
    const first = await readySocket(0);
    const loud = new Int16Array(1600).fill(8000).buffer;
    const quiet = new Int16Array(1600).fill(200).buffer;
    pushAudio(loud);

    jest.advanceTimersByTime(240_000);
    pushAudio(loud);
    pushAudio(quiet);
    pushAudio(quiet);
    expect(FakeSocket.instances).toHaveLength(1);

    pushAudio(quiet);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(first.audio()).toHaveLength(4);
    expect(first.json().at(-1)).toEqual({ type: 'stop' });
  });

  it('hands over anyway when no sentence ends within the grace period', async () => {
    jest.useFakeTimers();
    const speech = recognition();
    speech.start();
    const first = await readySocket(0);

    jest.advanceTimersByTime(240_000);
    first.receive({ type: 'interim', text: 'ohne Pause' });
    jest.advanceTimersByTime(39_999);
    expect(FakeSocket.instances).toHaveLength(1);

    jest.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(first.json().at(-1)).toEqual({ type: 'stop' });
  });

  it('keeps handing over for a long dictation', async () => {
    jest.useFakeTimers();
    const speech = recognition();
    speech.start();
    const first = await readySocket(0);

    jest.advanceTimersByTime(240_000);
    first.receive({ type: 'final', text: 'Eins.' });
    const second = FakeSocket.instances[1];
    second.open();
    second.receive({ type: 'ready' });

    jest.advanceTimersByTime(240_000);
    second.receive({ type: 'final', text: 'Zwei.' });

    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('finishes with the text so far when the server never confirms the stop', async () => {
    jest.useFakeTimers();
    const speech = recognition();
    speech.start();
    const socket = await readySocket();
    socket.receive({ type: 'interim', text: 'Kein Fieber' });

    speech.stop();
    jest.advanceTimersByTime(8_000);

    expect(texts(speech.onresult).at(-1)).toBe('final: Kein Fieber');
    expect(speech.onend).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);
  });

  it('refreshes an expired token once and starts again', async () => {
    const speech = recognition();
    speech.start();
    await flush();
    const first = FakeSocket.instances[0];
    first.open();
    pushAudio(chunk(1));

    first.receive({ type: 'error', code: 'unauthorized' });
    first.close();
    await flush();

    expect(deps.refreshToken).toHaveBeenCalledTimes(1);
    const second = FakeSocket.instances[1];
    second.open();
    expect(second.json()).toEqual([{ type: 'start', token: 'fresh-token', language: 'de-DE' }]);
    second.receive({ type: 'ready' });
    expect(second.audio()).toEqual([chunk(1)]);
    expect(speech.onerror).not.toHaveBeenCalled();
  });

  it('reports a lost connection, keeps the text unsent and stops the library restarting', async () => {
    const speech = recognition();
    speech.continuous = true;
    speech.start();
    const socket = await readySocket();
    socket.receive({ type: 'interim', text: 'Blutzucker' });

    socket.close();

    expect(speech.onerror).toHaveBeenCalledWith({ error: 'network' });
    expect(deps.onFailure).toHaveBeenCalledWith('connection');
    expect(speech.continuous).toBe(false);
    expect(speech.onend).toHaveBeenCalledTimes(1);
    expect(microphone.stop).toHaveBeenCalled();
    expect(texts(speech.onresult)).toEqual(['interim: Blutzucker']);
  });

  it('reports a refused microphone', async () => {
    deps.openMicrophone.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    const speech = recognition();
    speech.start();
    await flush();

    expect(speech.onerror).toHaveBeenCalledWith({ error: 'not-allowed' });
    expect(deps.onFailure).toHaveBeenCalledWith('microphone');
    expect(speech.onend).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances[0].readyState).toBe(3);
  });

  it('ends without a result when aborted', async () => {
    const speech = recognition();
    speech.start();
    const socket = await readySocket();
    socket.receive({ type: 'interim', text: 'Apixaban' });

    speech.abort();

    expect(texts(speech.onresult)).toEqual(['interim: Apixaban']);
    expect(speech.onend).toHaveBeenCalledTimes(1);
    expect(microphone.stop).toHaveBeenCalled();
    expect(socket.readyState).toBe(3);
  });

  it('stops a microphone that opens after the dictation already ended', async () => {
    let resolveMicrophone: (mic: Microphone) => void = () => undefined;
    deps.openMicrophone.mockImplementationOnce(
      () => new Promise((resolve) => (resolveMicrophone = resolve)),
    );
    const speech = recognition();
    speech.start();
    speech.abort();

    resolveMicrophone(microphone);
    await flush();

    expect(microphone.stop).toHaveBeenCalled();
  });
});
