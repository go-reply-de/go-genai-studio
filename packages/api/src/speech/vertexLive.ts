import WebSocket from 'ws';

/** Gemini Transcribe is served only from these locations, not from single regions. */
export const VERTEX_HOSTS: Record<string, string> = {
  eu: 'aiplatform.eu.rep.googleapis.com',
  us: 'aiplatform.us.rep.googleapis.com',
  global: 'aiplatform.googleapis.com',
};

export interface VertexLiveOptions {
  project: string;
  location: string;
  model: string;
  language?: string;
  getToken: () => Promise<string>;
  /** Defaults to the location's Vertex AI host. */
  url?: string;
}

export interface VertexLiveEvents {
  onReady: () => void;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onSpeech: (speaking: boolean) => void;
  onClose: (error?: Error) => void;
}

export interface VertexLiveStream {
  /** 16-bit little-endian mono PCM at 16 kHz. */
  send: (pcm: Buffer) => void;
  end: () => void;
  close: () => void;
}

interface LiveMessage {
  setupComplete?: unknown;
  voiceActivity?: { type?: string };
  serverContent?: {
    interimInputTranscription?: { text?: string };
    inputTranscription?: { text?: string };
  };
}

export function vertexLiveUrl(location: string): string {
  return `wss://${VERTEX_HOSTS[location]}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
}

/** Opens a transcription-only Live API session; text arrives through the events. */
export async function openVertexLive(
  options: VertexLiveOptions,
  events: VertexLiveEvents,
): Promise<VertexLiveStream> {
  const token = await options.getToken();
  const socket = new WebSocket(options.url ?? vertexLiveUrl(options.location), {
    headers: { Authorization: `Bearer ${token}` },
  });
  let closing = false;
  let finished = false;
  const finish = (error?: Error) => {
    if (!finished) {
      finished = true;
      events.onClose(error);
    }
  };
  const sendJson = (message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  socket.on('open', () =>
    sendJson({
      setup: {
        model: `projects/${options.project}/locations/${options.location}/publishers/google/models/${options.model}`,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: {
          mode: 'VERBATIM',
          ...(options.language && { languageCodes: [options.language] }),
        },
      },
    }),
  );

  socket.on('message', (data) => {
    let message: LiveMessage;
    try {
      message = JSON.parse(data.toString()) as LiveMessage;
    } catch {
      return;
    }
    if (message.setupComplete) {
      events.onReady();
    }
    const interim = message.serverContent?.interimInputTranscription?.text;
    if (interim) {
      events.onInterim(interim);
    }
    const final = message.serverContent?.inputTranscription?.text;
    if (final) {
      events.onFinal(final);
    }
    if (message.voiceActivity?.type === 'ACTIVITY_START') {
      events.onSpeech(true);
    } else if (message.voiceActivity?.type === 'ACTIVITY_END') {
      events.onSpeech(false);
    }
  });

  socket.on('error', (error) => finish(error));
  socket.on('close', (code, reason) =>
    finish(
      closing ? undefined : new Error(`Vertex AI closed the session: ${code} ${reason.toString()}`),
    ),
  );

  return {
    send: (pcm) =>
      sendJson({
        realtimeInput: {
          audio: { mimeType: 'audio/pcm;rate=16000', data: pcm.toString('base64') },
        },
      }),
    end: () => sendJson({ realtimeInput: { audioStreamEnd: true } }),
    close: () => {
      closing = true;
      socket.close(1000);
    },
  };
}
