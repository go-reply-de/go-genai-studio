import http from 'http';
import path from 'path';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '@librechat/data-schemas';
import { extractEnvVariable } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { loadServiceKey } from '~/utils/key';

/**
 * Speech-to-text through Gemini Transcribe. The STT config points LibreChat's OpenAI-style
 * upload at a listener on 127.0.0.1, which sends the audio to Vertex AI with the service key.
 */
export interface TranscribeTarget {
  port: number;
  path: string;
  apiKey: string;
}

export interface TranscribeRequest {
  audio: Buffer;
  mimeType: string;
  model: string;
  language?: string;
}

export interface VertexClient {
  project: string;
  location: string;
  getToken: () => Promise<string>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Gemini Transcribe is served only from these locations, not from single regions. */
const VERTEX_HOSTS: Record<string, string> = {
  eu: 'aiplatform.eu.rep.googleapis.com',
  us: 'aiplatform.us.rep.googleapis.com',
  global: 'aiplatform.googleapis.com',
};

const AUDIO_TYPES: Record<string, string> = {
  webm: 'audio/webm',
  wav: 'audio/wav',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
};

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const VERTEX_TIMEOUT_MS = 60_000;

export function getTranscribeTarget(appConfig?: AppConfig): TranscribeTarget | null {
  const openai = appConfig?.speech?.stt?.openai;
  if (!openai?.url) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(openai.url);
  } catch {
    return null;
  }
  const apiKey = extractEnvVariable(openai.apiKey ?? '');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !apiKey) {
    return null;
  }
  return { port: Number(url.port), path: url.pathname, apiKey };
}

export async function transcribeWithGemini(
  input: TranscribeRequest,
  client: VertexClient,
): Promise<string> {
  const host = VERTEX_HOSTS[client.location];
  const url = `https://${host}/v1/projects/${client.project}/locations/${client.location}/publishers/google/models/${input.model}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: input.mimeType, data: input.audio.toString('base64') } }],
      },
    ],
    generationConfig: {
      audioTranscriptionConfig: {
        mode: 'VERBATIM',
        ...(input.language && { languageCodes: [input.language] }),
      },
    },
  };

  const res = await (client.fetch ?? fetch)(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await client.getToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(VERTEX_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Vertex AI answered ${res.status}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

/** The STT upload labels audio.webm as video/webm, which Transcribe answers with no text. */
function audioType(file: File): string {
  const type = file.type.split(';')[0];
  if (type.startsWith('audio/')) {
    return type;
  }
  const extension = path.extname(file.name).slice(1).toLowerCase();
  return AUDIO_TYPES[extension] ?? 'audio/webm';
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createTranscribeServer(
  target: TranscribeTarget,
  transcribe: (input: TranscribeRequest) => Promise<string>,
  options: { maxBytes?: number } = {},
): http.Server {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== target.path) {
      send(res, 404, { error: { message: 'Not found' } });
      return;
    }
    if (req.headers.authorization !== `Bearer ${target.apiKey}`) {
      send(res, 401, { error: { message: 'Unauthorized' } });
      return;
    }

    const raw = await readBody(req, maxBytes);
    if (!raw) {
      send(res, 413, { error: { message: 'Audio too large' } });
      return;
    }

    let form: FormData;
    try {
      form = await new Request('http://127.0.0.1', {
        method: 'POST',
        headers: { 'Content-Type': req.headers['content-type'] ?? '' },
        body: new Uint8Array(raw),
      }).formData();
    } catch {
      send(res, 400, { error: { message: 'Expected a multipart upload' } });
      return;
    }

    const file = form.get('file');
    const model = form.get('model');
    if (!(file instanceof File) || typeof model !== 'string') {
      send(res, 400, { error: { message: 'Expected file and model fields' } });
      return;
    }
    const language = form.get('language');

    const started = Date.now();
    try {
      const text = await transcribe({
        audio: Buffer.from(await file.arrayBuffer()),
        mimeType: audioType(file),
        model,
        ...(typeof language === 'string' && language && { language }),
      });
      logger.debug(`[transcribe] ${model} ${file.size} bytes in ${Date.now() - started} ms`);
      send(res, 200, { text });
    } catch (error) {
      logger.error(`[transcribe] ${model} failed: ${(error as Error).message}`);
      send(res, 502, { error: { message: 'Transcription failed' } });
    }
  });
}

/** Starts the listener when the STT url points at 127.0.0.1; returns null otherwise. */
export async function startTranscribeService(appConfig?: AppConfig): Promise<http.Server | null> {
  const target = getTranscribeTarget(appConfig);
  if (!target) {
    return null;
  }
  const location = process.env.GOOGLE_LOC ?? '';
  if (!VERTEX_HOSTS[location]) {
    logger.error(
      `[transcribe] GOOGLE_LOC must be eu, us or global, not "${location}"; STT stays off`,
    );
    return null;
  }
  const keyPath =
    process.env.GOOGLE_SERVICE_KEY_FILE || path.join(process.cwd(), 'api', 'data', 'auth.json');
  const key = await loadServiceKey(keyPath);
  if (!key?.project_id) {
    logger.error('[transcribe] No Google service key found; STT stays off');
    return null;
  }

  const auth = new GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client: VertexClient = {
    project: key.project_id,
    location,
    getToken: async () => (await auth.getAccessToken()) ?? '',
  };

  const server = createTranscribeServer(target, (input) => transcribeWithGemini(input, client));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(target.port, '127.0.0.1', () => resolve());
    });
  } catch (error) {
    logger.error(
      `[transcribe] Cannot listen on 127.0.0.1:${target.port}: ${(error as Error).message}`,
    );
    return null;
  }
  logger.info(`[transcribe] Listening on 127.0.0.1:${target.port}${target.path} (${location})`);
  return server;
}
