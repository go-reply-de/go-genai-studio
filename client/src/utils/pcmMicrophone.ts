export const PCM_SAMPLE_RATE = 16_000;
const CHUNK_SECONDS = 0.1;
const PROCESSOR_NAME = 'pcm16-capture';

export interface Microphone {
  stop: () => void;
}

/**
 * Runs on the audio thread and posts 100 ms chunks of 16 kHz PCM. resample() averages each
 * window of input samples into one 16-bit sample. Plain JavaScript, as it runs untranspiled.
 */
export const PCM_WORKLET_SOURCE = `
function resample(input, length) {
  const output = new Int16Array(length);
  const step = input.length / length;
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * step)));
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
    }
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

class Pcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = Math.round(sampleRate * ${CHUNK_SECONDS});
    this.buffer = new Float32Array(this.block);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    let offset = 0;
    while (channel && offset < channel.length) {
      const count = Math.min(channel.length - offset, this.block - this.filled);
      this.buffer.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.block) {
        const pcm = resample(this.buffer, ${PCM_SAMPLE_RATE * CHUNK_SECONDS});
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('${PROCESSOR_NAME}', Pcm16Capture);
`;

/** Prefers a 16 kHz context, where the browser resamples the microphone itself. */
function connectSource(stream: MediaStream): {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
} {
  const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
  try {
    return { context, source: context.createMediaStreamSource(stream) };
  } catch {
    void context.close();
    const fallback = new AudioContext();
    return { context: fallback, source: fallback.createMediaStreamSource(stream) };
  }
}

/** Records the microphone as 16 kHz mono PCM and hands over each 100 ms chunk. */
export async function openPcmMicrophone(onChunk: (pcm: ArrayBuffer) => void): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
  let opened: AudioContext | undefined;
  try {
    const { context, source } = connectSource(stream);
    opened = context;
    const url = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(context, PROCESSOR_NAME);
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onChunk(event.data);
    source.connect(node);
    node.connect(context.destination);
    return {
      stop: () => {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        stopTracks();
        void context.close();
      },
    };
  } catch (error) {
    stopTracks();
    void opened?.close();
    throw error;
  }
}
