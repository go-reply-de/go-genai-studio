import { PCM_WORKLET_SOURCE } from '../pcmMicrophone';

type Processor = {
  port: { postMessage: jest.Mock };
  process: (inputs: Float32Array[][]) => boolean;
};
type Resample = (input: Float32Array, length: number) => Int16Array;

/** Evaluates the worklet source as the audio thread would, with its globals faked. */
function loadWorklet(sampleRate: number): { processor: Processor; resample: Resample } {
  let Registered: (new () => Processor) | undefined;
  class FakeAudioWorkletProcessor {
    port = { postMessage: jest.fn() };
  }
  const register = (_name: string, processor: new () => Processor) => {
    Registered = processor;
  };
  const resample = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    `${PCM_WORKLET_SOURCE}\nreturn resample;`,
  )(FakeAudioWorkletProcessor, register, sampleRate) as Resample;
  if (!Registered) {
    throw new Error('the worklet registered no processor');
  }
  return { processor: new Registered(), resample };
}

describe('the worklet resample()', () => {
  const { resample } = loadWorklet(48_000);

  it('averages each window of input samples into one 16-bit sample', () => {
    const input = new Float32Array([0.5, 0.5, 0.5, -1, -1, -1]);
    expect(Array.from(resample(input, 2))).toEqual([16383, -32768]);
  });

  it('keeps the samples when the rates already match', () => {
    expect(Array.from(resample(new Float32Array([0, 1, -1]), 3))).toEqual([0, 32767, -32768]);
  });

  it('clips samples outside the valid range', () => {
    expect(Array.from(resample(new Float32Array([2, -2]), 2))).toEqual([32767, -32768]);
  });
});

describe('the worklet processor', () => {
  it('posts 100 ms of 16 kHz PCM for every 100 ms of microphone input', () => {
    const { processor } = loadWorklet(48_000);
    const block = new Float32Array(128).fill(0.25);

    for (let i = 0; i < 37; i++) {
      expect(processor.process([[block]])).toBe(true);
    }
    expect(processor.port.postMessage).not.toHaveBeenCalled();

    processor.process([[block]]);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    const [buffer] = processor.port.postMessage.mock.calls[0];
    const pcm = new Int16Array(buffer as ArrayBuffer);
    expect(pcm).toHaveLength(1600);
    expect(pcm[0]).toBe(8191);
  });

  it('keeps running without input', () => {
    expect(loadWorklet(16_000).processor.process([[]])).toBe(true);
  });
});
