import type { Microphone } from './pcmMicrophone';

export type { Microphone } from './pcmMicrophone';

export type FailureReason = 'microphone' | 'connection';

export interface TranscribeRecognitionDeps {
  /** The api's dictation WebSocket. */
  url: () => string;
  getToken: () => string | undefined;
  /** Renews an expired access token. */
  refreshToken: () => Promise<void>;
  openMicrophone: (onChunk: (pcm: ArrayBuffer) => void) => Promise<Microphone>;
  /** Used when the speech settings name no language. */
  defaultLanguage?: () => string | undefined;
  createSocket?: (url: string) => WebSocket;
  onFailure?: (reason: FailureReason) => void;
  /** When a session hands over at the next end of a sentence. */
  handoverMs?: number;
  /** How long it waits for that sentence; both stay under the load balancer's 300 s limit. */
  handoverGraceMs?: number;
  stopTimeoutMs?: number;
}

export type RecognitionResult = ArrayLike<{ transcript: string; confidence: number }> & {
  isFinal: boolean;
};

export interface RecognitionResultEvent {
  resultIndex: number;
  results: RecognitionResult[];
}

interface Session {
  socket: WebSocket;
  ready: boolean;
  queue: ArrayBuffer[];
  committed: string;
  interim: string;
  stopRequested: boolean;
  done: boolean;
}

/** About ten seconds of audio while a session connects. */
const MAX_QUEUED_CHUNKS = 100;

/** A pause is 300 ms below a tenth of the recent speech level, which adapts to the microphone. */
const QUIET_RATIO = 0.1;
const QUIET_CHUNKS = 3;
const PEAK_DECAY = 0.995;

const join = (...parts: string[]) => parts.filter(Boolean).join(' ');

function level(pcm: ArrayBuffer): number {
  const samples = new Int16Array(pcm);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
}

function result(transcript: string, isFinal: boolean): RecognitionResult {
  return Object.assign([{ transcript, confidence: 1 }], { isFinal });
}

/**
 * A SpeechRecognition for react-speech-recognition that streams the microphone to the api's
 * Gemini Transcribe endpoint instead of the browser vendor's service. The text grows as one
 * interim result while the user speaks and becomes final once dictation stops.
 */
export function createTranscribeRecognition(deps: TranscribeRecognitionDeps) {
  const handoverMs = deps.handoverMs ?? 240_000;
  const handoverGraceMs = deps.handoverGraceMs ?? 40_000;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 8_000;
  const createSocket = deps.createSocket ?? ((url: string) => new WebSocket(url));

  return class TranscribeRecognition {
    continuous = false;
    interimResults = true;
    lang = '';
    onresult: ((event: RecognitionResultEvent) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;

    private running = false;
    private stopping = false;
    private refreshed = false;
    private sessions: Session[] = [];
    private current: Session | null = null;
    private microphone: Microphone | null = null;
    private handoverTimer: ReturnType<typeof setTimeout> | null = null;
    private handoverDue: Session | null = null;
    private stopTimer: ReturnType<typeof setTimeout> | null = null;
    private shown = '';
    private peak = 0;
    private quietChunks = 0;

    start() {
      if (this.running) {
        return;
      }
      this.running = true;
      this.stopping = false;
      this.refreshed = false;
      this.sessions = [];
      this.shown = '';
      this.peak = 0;
      this.quietChunks = 0;
      this.openSession([]);
      this.scheduleHandover();
      deps
        .openMicrophone((pcm) => this.route(pcm))
        .then(
          (microphone) => {
            if (this.running && !this.stopping) {
              this.microphone = microphone;
            } else {
              microphone.stop();
            }
          },
          () => this.fail('not-allowed', 'microphone'),
        );
    }

    /** Ends recording; the result follows once the server has transcribed the rest. */
    stop() {
      if (!this.running || this.stopping) {
        return;
      }
      this.stopping = true;
      this.clearHandover();
      this.microphone?.stop();
      this.microphone = null;
      if (this.current) {
        this.requestStop(this.current);
      }
      this.stopTimer = setTimeout(() => this.finish(), stopTimeoutMs);
    }

    abort() {
      if (!this.running) {
        return;
      }
      this.end();
      this.onend?.();
    }

    private openSession(queue: ArrayBuffer[]) {
      const socket = createSocket(deps.url());
      socket.binaryType = 'arraybuffer';
      const session: Session = {
        socket,
        ready: false,
        queue,
        committed: '',
        interim: '',
        stopRequested: false,
        done: false,
      };
      this.sessions.push(session);
      this.current = session;
      const language = this.lang || deps.defaultLanguage?.();
      socket.onopen = () =>
        socket.send(
          JSON.stringify({ type: 'start', token: deps.getToken(), ...(language && { language }) }),
        );
      socket.onmessage = (event: MessageEvent) => this.receive(session, event.data);
      socket.onclose = () => this.closed(session);
    }

    private requestStop(session: Session) {
      session.stopRequested = true;
      if (session.ready) {
        session.socket.send(JSON.stringify({ type: 'stop' }));
      }
    }

    private route(pcm: ArrayBuffer) {
      if (!this.running || this.stopping) {
        return;
      }
      const rms = level(pcm);
      this.peak = Math.max(rms, this.peak * PEAK_DECAY);
      this.quietChunks = rms < this.peak * QUIET_RATIO ? this.quietChunks + 1 : 0;
      if (this.handoverDue && this.quietChunks >= QUIET_CHUNKS) {
        this.handover();
      }
      const session = this.current;
      if (!session) {
        return;
      }
      if (session.ready) {
        session.socket.send(pcm);
        return;
      }
      session.queue.push(pcm);
      if (session.queue.length > MAX_QUEUED_CHUNKS) {
        session.queue.shift();
      }
    }

    /** A cut in the middle of speech loses the word it splits, so sessions hand over in pauses. */
    private scheduleHandover() {
      this.clearHandover();
      this.handoverTimer = setTimeout(() => {
        this.handoverDue = this.current;
        this.handoverTimer = setTimeout(() => this.handover(), handoverGraceMs);
      }, handoverMs);
    }

    /** Starts the next session and lets the previous one finish its text. */
    private handover() {
      const previous = this.current;
      if (!this.running || this.stopping || !previous) {
        return;
      }
      this.openSession(previous.ready ? [] : previous.queue.splice(0));
      this.requestStop(previous);
      this.scheduleHandover();
    }

    private receive(session: Session, data: unknown) {
      if (!this.running || typeof data !== 'string') {
        return;
      }
      let message: { type?: string; text?: string; code?: string };
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.type === 'ready') {
        session.ready = true;
        session.queue.splice(0).forEach((pcm) => session.socket.send(pcm));
        if (session.stopRequested) {
          session.socket.send(JSON.stringify({ type: 'stop' }));
        }
      } else if (message.type === 'interim') {
        session.interim = message.text ?? '';
        this.show();
      } else if (message.type === 'final') {
        session.committed = join(session.committed, message.text ?? '');
        session.interim = '';
        this.show();
        if (this.handoverDue === session) {
          this.handover();
        }
      } else if (message.type === 'done') {
        session.done = true;
        session.socket.close();
        if (this.stopping && this.sessions.every((each) => each.done)) {
          this.finish();
        }
      } else if (message.type === 'error') {
        this.refuse(session, message.code);
      }
    }

    /** Access tokens expire after minutes; one refresh covers a dictation started after idling. */
    private refuse(session: Session, code?: string) {
      session.done = true;
      if (code !== 'unauthorized' || this.refreshed || session !== this.current) {
        this.fail('network', 'connection');
        return;
      }
      this.refreshed = true;
      this.sessions = this.sessions.filter((each) => each !== session);
      session.socket.close();
      deps.refreshToken().then(
        () => {
          if (!this.running) {
            return;
          }
          this.openSession(session.queue);
          if (this.stopping && this.current) {
            this.requestStop(this.current);
          }
        },
        () => this.fail('network', 'connection'),
      );
    }

    private closed(session: Session) {
      if (this.running && !session.done) {
        this.fail('network', 'connection');
      }
    }

    private text(): string {
      return this.sessions
        .map((session) => join(session.committed, session.interim))
        .filter(Boolean)
        .join(' ');
    }

    private show() {
      const text = this.text();
      if (text !== this.shown) {
        this.shown = text;
        this.onresult?.({ resultIndex: 0, results: [result(text, false)] });
      }
    }

    private finish() {
      if (!this.running) {
        return;
      }
      const text = this.text();
      this.end();
      if (text) {
        this.onresult?.({ resultIndex: 0, results: [result(text, true)] });
      }
      this.onend?.();
    }

    /** The text so far stays in the input, but is not sent as a final result. */
    private fail(error: string, reason: FailureReason) {
      if (!this.running) {
        return;
      }
      this.end();
      this.continuous = false;
      this.onerror?.({ error });
      deps.onFailure?.(reason);
      this.onend?.();
    }

    private clearHandover() {
      this.handoverDue = null;
      if (this.handoverTimer) {
        clearTimeout(this.handoverTimer);
        this.handoverTimer = null;
      }
    }

    private end() {
      this.running = false;
      this.stopping = false;
      this.clearHandover();
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }
      this.microphone?.stop();
      this.microphone = null;
      this.sessions.forEach((session) => {
        session.done = true;
        session.socket.close();
      });
      this.current = null;
    }
  };
}
