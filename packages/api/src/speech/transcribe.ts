import path from 'path';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { Application } from 'express';
import type { Duplex } from 'stream';
import type { RawData } from 'ws';
import type WebSocket from 'ws';
import type http from 'http';
import type { VertexLiveEvents, VertexLiveStream } from './vertexLive';
import { VERTEX_HOSTS, openVertexLive } from './vertexLive';
import { loadServiceKey } from '~/utils/key';

/**
 * Live dictation through Gemini Transcribe. The browser streams microphone PCM over a WebSocket
 * on this path, and the api relays it to Vertex AI with its service key.
 */
export const TRANSCRIBE_PATH = '/api/speech/transcribe';

const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const PCM_BYTES_PER_SECOND = 32_000;

export type TranscribeErrorCode = 'unauthorized' | 'busy' | 'unavailable' | 'bad_request';

export interface TranscribeEndpointOptions {
  openStream: (language: string | undefined, events: VertexLiveEvents) => Promise<VertexLiveStream>;
  /** Returns the user id for a valid access token. */
  verifyUser: (token: string) => string | null;
  allowedOrigin?: string;
  /** Under the load balancer's 300 s limit, so the browser hands over to a new session first. */
  maxSessionMs?: number;
  /** Two, so a session can finish while the browser's next one starts. */
  maxSessionsPerUser?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** Dictation goes to Gemini Transcribe when the STT url in the config points at 127.0.0.1. */
export function getTranscribeModel(appConfig?: AppConfig): string | null {
  const openai = appConfig?.speech?.stt?.openai;
  if (!openai?.url || !openai.model) {
    return null;
  }
  try {
    return new URL(openai.url).hostname === '127.0.0.1' ? openai.model : null;
  } catch {
    return null;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export function createTranscribeEndpoint(
  options: TranscribeEndpointOptions,
): (server: http.Server) => void {
  const {
    maxSessionMs = 290_000,
    maxSessionsPerUser = 2,
    startTimeoutMs = 5_000,
    stopTimeoutMs = 5_000,
  } = options;
  const sessions = new Map<string, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const handle = (socket: WebSocket) => {
    let userId: string | null = null;
    let stream: VertexLiveStream | undefined;
    let begun = false;
    let ready = false;
    let speaking = false;
    let stopping = false;
    let finished = false;
    let audioBytes = 0;
    const started = Date.now();
    const timers: NodeJS.Timeout[] = [];

    const sendJson = (message: Record<string, string>) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };

    const cleanup = () => {
      finished = true;
      timers.forEach(clearTimeout);
      stream?.close();
      stream = undefined;
      if (userId) {
        const left = (sessions.get(userId) ?? 1) - 1;
        if (left > 0) {
          sessions.set(userId, left);
        } else {
          sessions.delete(userId);
        }
        userId = null;
        logger.debug(
          `[transcribe] ${(audioBytes / PCM_BYTES_PER_SECOND).toFixed(1)} s of audio in ${Date.now() - started} ms`,
        );
      }
    };

    const finish = (closeCode: number, message: Record<string, string>) => {
      if (finished) {
        return;
      }
      sendJson(message);
      socket.close(closeCode);
      cleanup();
    };
    const done = () => finish(1000, { type: 'done' });
    const fail = (code: TranscribeErrorCode) =>
      finish(code === 'unavailable' ? 1011 : 1008, { type: 'error', code });

    /** The final text of an utterance arrives before Vertex AI reports the end of speech. */
    const stop = () => {
      if (stopping || finished) {
        return;
      }
      stopping = true;
      stream?.end();
      if (ready && speaking) {
        timers.push(setTimeout(done, stopTimeoutMs));
      } else {
        done();
      }
    };

    const events: VertexLiveEvents = {
      onReady: () => {
        ready = true;
        sendJson({ type: 'ready' });
      },
      onInterim: (text) => sendJson({ type: 'interim', text }),
      onFinal: (text) => sendJson({ type: 'final', text }),
      onSpeech: (value) => {
        speaking = value;
        if (stopping && !value) {
          done();
        }
      },
      onClose: (error) => {
        if (!error) {
          done();
          return;
        }
        logger.warn(`[transcribe] ${error.message}`);
        fail('unavailable');
      },
    };

    const begin = async (token: unknown, language: unknown) => {
      begun = true;
      const user = typeof token === 'string' ? options.verifyUser(token) : null;
      if (!user) {
        fail('unauthorized');
        return;
      }
      const active = sessions.get(user) ?? 0;
      if (active >= maxSessionsPerUser) {
        fail('busy');
        return;
      }
      sessions.set(user, active + 1);
      userId = user;
      timers.push(setTimeout(stop, maxSessionMs));

      const tag =
        typeof language === 'string' && LANGUAGE_TAG.test(language) ? language : undefined;
      try {
        const opened = await options.openStream(tag, events);
        if (finished) {
          opened.close();
          return;
        }
        stream = opened;
      } catch (error) {
        logger.warn(`[transcribe] Cannot open a Vertex AI session: ${(error as Error).message}`);
        fail('unavailable');
      }
    };

    timers.push(setTimeout(() => !begun && fail('bad_request'), startTimeoutMs));

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (finished) {
        return;
      }
      if (isBinary) {
        if (stream && ready && !stopping) {
          const pcm = toBuffer(data);
          audioBytes += pcm.length;
          stream.send(pcm);
        }
        return;
      }
      let message: { type?: unknown; token?: unknown; language?: unknown };
      try {
        message = JSON.parse(data.toString());
      } catch {
        fail('bad_request');
        return;
      }
      if (message.type === 'start' && !begun) {
        void begin(message.token, message.language);
      } else if (message.type === 'stop') {
        stop();
      }
    });
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  };

  return (server) => {
    server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== TRANSCRIBE_PATH) {
        if (server.listenerCount('upgrade') === 1) {
          socket.destroy();
        }
        return;
      }
      if (options.allowedOrigin && req.headers.origin !== options.allowedOrigin) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, handle);
    });
  };
}

function originOf(url?: string): string | undefined {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds the dictation endpoint to the server the app starts, when the config turns it on.
 * Returns whether it did.
 */
export async function startTranscribeService(
  app: Application,
  appConfig?: AppConfig,
): Promise<boolean> {
  const model = getTranscribeModel(appConfig);
  if (!model) {
    return false;
  }
  const location = process.env.GOOGLE_LOC ?? '';
  if (!VERTEX_HOSTS[location]) {
    logger.error(
      `[transcribe] GOOGLE_LOC must be eu, us or global, not "${location}"; dictation stays off`,
    );
    return false;
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    logger.error('[transcribe] JWT_SECRET is not set; dictation stays off');
    return false;
  }
  const keyPath =
    process.env.GOOGLE_SERVICE_KEY_FILE || path.join(process.cwd(), 'api', 'data', 'auth.json');
  const key = await loadServiceKey(keyPath);
  if (!key?.project_id) {
    logger.error('[transcribe] No Google service key found; dictation stays off');
    return false;
  }

  const auth = new GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const project = key.project_id;
  const allowedOrigin = originOf(process.env.DOMAIN_CLIENT);
  if (!allowedOrigin) {
    logger.warn('[transcribe] DOMAIN_CLIENT is not set; dictation accepts any origin');
  }
  const attach = createTranscribeEndpoint({
    openStream: (language, events) =>
      openVertexLive(
        {
          project,
          location,
          model,
          language,
          getToken: async () => (await auth.getAccessToken()) ?? '',
        },
        events,
      ),
    verifyUser: (token) => {
      try {
        const payload = jwt.verify(token, secret);
        return typeof payload === 'object' && typeof payload.id === 'string' ? payload.id : null;
      } catch {
        return null;
      }
    },
    allowedOrigin,
  });

  const listen = app.listen.bind(app) as (...args: unknown[]) => http.Server;
  app.listen = ((...args: unknown[]) => {
    const server = listen(...args);
    attach(server);
    return server;
  }) as Application['listen'];

  logger.info(`[transcribe] Dictation through ${model} on ${TRANSCRIBE_PATH} (${location})`);
  return true;
}
