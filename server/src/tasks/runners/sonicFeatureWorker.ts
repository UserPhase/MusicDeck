import { parentPort, workerData } from "node:worker_threads";

export const SONIC_SAMPLE_RATE = 12000;
const FFT_SIZE = 1024;
const HOP = 256;
const BANDS = 24;
const BINS = FFT_SIZE / 2 + 1;

function fft(real: Float64Array, imaginary: Float64Array): void {
  for (let index = 1, reverse = 0; index < FFT_SIZE; index++) {
    let bit = FFT_SIZE >> 1;
    while (reverse & bit) { reverse ^= bit; bit >>= 1; }
    reverse ^= bit;
    if (index < reverse) [real[index], real[reverse]] = [real[reverse], real[index]];
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const angle = -2 * Math.PI / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < FFT_SIZE; offset += size) {
      let cosine = 1;
      let sine = 0;
      for (let position = offset; position < offset + half; position++) {
        const opposite = position + half;
        const x = real[opposite] * cosine - imaginary[opposite] * sine;
        const y = real[opposite] * sine + imaginary[opposite] * cosine;
        real[opposite] = real[position] - x;
        imaginary[opposite] = imaginary[position] - y;
        real[position] += x;
        imaginary[position] += y;
        const nextCosine = cosine * stepReal - sine * stepImaginary;
        sine = cosine * stepImaginary + sine * stepReal;
        cosine = nextCosine;
      }
    }
  }
}

/** 32 cepstral, 48 mel, 24 chroma, 16 rhythm, and 8 spectral dimensions. */
export function extractSonicFeatures(samples: Float32Array): Float32Array {
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  const previous = new Float64Array(BINS);
  const power = new Float64Array(BINS);
  const mel = (frequency: number) => 2595 * Math.log10(1 + frequency / 700);
  const weights = Array.from({ length: BANDS }, (_, band) => {
    const top = mel(SONIC_SAMPLE_RATE / 2);
    return Float64Array.from({ length: BINS }, (_, bin) => {
      const position = mel(bin * SONIC_SAMPLE_RATE / FFT_SIZE) * (BANDS + 1) / top;
      return Math.max(0, 1 - Math.abs(position - band - 1));
    });
  });
  const chromaBins = Int8Array.from({ length: BINS }, (_, bin) => {
    const frequency = bin * SONIC_SAMPLE_RATE / FFT_SIZE;
    return frequency < 55 || frequency > 4000 ? -1 : (Math.round(69 + 12 * Math.log2(frequency / 440)) + 120) % 12;
  });
  const dct = Array.from({ length: 16 }, (_, index) => Float64Array.from({ length: BANDS },
    (_, band) => Math.cos(Math.PI * (index + 1) * (band + 0.5) / BANDS)));
  const sums = new Float64Array(56);
  const squares = new Float64Array(56);
  const envelope: number[] = [];
  let frames = 0;
  for (let start = 0; start + FFT_SIZE <= samples.length; start += HOP) {
    imaginary.fill(0);
    for (let index = 0; index < FFT_SIZE; index++) real[index] = samples[start + index] * window[index];
    fft(real, imaginary);
    let energy = 0;
    for (let bin = 1; bin < BINS; bin++) {
      power[bin] = real[bin] ** 2 + imaginary[bin] ** 2;
      energy += power[bin];
    }
    if (energy < 0.0001) {
      envelope.push(0);
      previous.fill(0);
      continue;
    }
    const chroma = new Float64Array(12);
    let centroid = 0, secondMoment = 0, rolloff = 0, cumulative = 0, flux = 0;
    for (let bin = 1; bin < BINS; bin++) {
      power[bin] /= energy;
      const frequency = bin / (BINS - 1);
      centroid += frequency * power[bin];
      secondMoment += frequency ** 2 * power[bin];
      cumulative += power[bin];
      if (!rolloff && cumulative >= 0.85) rolloff = frequency;
      const amplitude = Math.sqrt(power[bin]);
      flux += Math.max(0, amplitude - previous[bin]) ** 2;
      previous[bin] = amplitude;
      if (chromaBins[bin] >= 0) chroma[chromaBins[bin]] += power[bin];
    }
    const bands = weights.map(weight => {
      let value = 0;
      for (let bin = 1; bin < BINS; bin++) value += weight[bin] * power[bin];
      return Math.log(value + 1e-6);
    });
    const cepstra = dct.map(coefficients => Math.tanh(bands.reduce((sum, value, band) =>
      sum + value * coefficients[band], 0) / BANDS));
    const chromaTotal = chroma.reduce((sum, value) => sum + value, 0) || 1;
    const descriptors = [...cepstra, ...bands.map(value => Math.exp(value / 4)),
      ...chroma.map(value => Math.sqrt(value / chromaTotal)),
      centroid, Math.sqrt(Math.max(0, secondMoment - centroid ** 2)), rolloff, Math.sqrt(flux)];
    descriptors.forEach((value, index) => { sums[index] += value; squares[index] += value ** 2; });
    envelope.push(Math.sqrt(flux));
    frames++;
  }
  if (frames < 8) throw new Error("Audio sample is silent or too short for sonic analysis.");
  const moments = (start: number, end: number) => Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset;
    const mean = sums[index] / frames;
    return [mean, Math.sqrt(Math.max(0, squares[index] / frames - mean ** 2))];
  }).flat();
  const mean = envelope.reduce((sum, value) => sum + value, 0) / envelope.length;
  const rhythm = Array.from({ length: 16 }, (_, index) => {
    const lag = Math.round(60 * SONIC_SAMPLE_RATE / (HOP * (55 + index * 10)));
    let cross = 0, left = 0, right = 0;
    for (let frame = lag; frame < envelope.length; frame++) {
      const a = envelope[frame] - mean;
      const b = envelope[frame - lag] - mean;
      cross += a * b;
      left += a ** 2;
      right += b ** 2;
    }
    return Math.max(0, cross / (Math.sqrt(left * right) || 1));
  });
  return Float32Array.from([...moments(0, 16), ...moments(16, 40), ...moments(40, 52), ...rhythm, ...moments(52, 56)]);
}

if (parentPort && workerData?.kind === "musicdeck-sonic") {
  try {
    const pcm = new DataView(workerData.pcm);
    const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, index) => pcm.getInt16(index * 2, true) / 32768);
    const features = extractSonicFeatures(samples);
    parentPort.postMessage({ features }, [features.buffer as ArrayBuffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : "Feature extraction failed." });
  }
}
