export const EQ_FREQUENCIES = {
  3: [100, 1000, 10000],
  5: [60, 230, 910, 4000, 14000],
  10: [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
} as const;
export type EqualizerBandCount = keyof typeof EQ_FREQUENCIES;

export const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0],
  "Bass Boost": [6, 2, 0, 0, 0],
  "Vocal Enhancer": [-2, -1, 3, 3, 0],
  Vocal: [-2, -1, 3, 3, 0],
  Rock: [4, 2, -2, 2, 4],
  Electronic: [5, 2, -1, 2, 4],
  Acoustic: [2, 0, -1, 2, 3],
} as const;
export type EqualizerPreset = keyof typeof EQ_PRESETS | "Custom";
export const PARAMETRIC_FILTER_TYPES = {
  peaking: "Bell (Peaking EQ)", lowshelf: "Low Shelf", highshelf: "High Shelf",
  lowpass: "Low Pass", highpass: "High Pass", notch: "Notch",
} as const;
export type ParametricBand = { type: keyof typeof PARAMETRIC_FILTER_TYPES; frequency: number; gain: number; q: number };
export const filterUsesGain = (type: ParametricBand["type"]) => type === "peaking" || type === "lowshelf" || type === "highshelf";
export const filterUsesQ = (type: ParametricBand["type"]) => type !== "lowshelf" && type !== "highshelf";
// Web Audio takes Q in dB for pass filters and linear Q for bell and notch.
export const webAudioFilterQ = ({ type, q }: ParametricBand) => type === "lowpass" || type === "highpass" ? 20 * Math.log10(q) : q;
export const MAX_PARAMETRIC_BANDS = 10;
export const MAX_CUSTOM_GRAPHIC_BANDS = 10;
export type GraphicBand = { frequency: number; gain: number };
export const DEFAULT_GRAPHIC_BANDS: readonly GraphicBand[] = EQ_FREQUENCIES[5].map(frequency => ({ frequency, gain: 0 }));
export const DEFAULT_PARAMETRIC_BAND: Readonly<ParametricBand> = { type: "peaking", frequency: 1000, gain: 0, q: 1 };
export type EqualizerSettings = {
  bandCount: EqualizerBandCount; preset: EqualizerPreset; custom: readonly number[];
  mode: "graphic" | "parametric"; parametric: readonly ParametricBand[];
  enabled?: boolean;
  graphicCustomEnabled?: boolean; graphicCustom?: readonly GraphicBand[];
};
export const EQ_LIMITS = {
  frequency: { min: 20, max: 20000, step: 1 },
  gain: { min: -12, max: 12, step: 0.5 },
  q: { min: 0.1, max: 10, step: 0.1 },
} as const;
const STORAGE_KEY = "musicdeck:equalizer:v1";
const MAX_BOOST = 12;
const LIMITER_INPUT_RANGE = 32;
const LIMITER_KNEE = 0.89;
const LIMITER_CEILING = 0.98;

export function cleanBands(values: unknown, bandCount: EqualizerBandCount = 5): number[] {
  return EQ_FREQUENCIES[bandCount].map((_, index) => {
    const gain = Array.isArray(values) ? values[index] : undefined;
    return typeof gain === "number" && Number.isFinite(gain)
      ? Math.max(-MAX_BOOST, Math.min(MAX_BOOST, gain)) : 0;
  });
}

export function readEqualizerSettings(): EqualizerSettings {
  try {
    return normalizeEqualizerSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
  } catch { /* Storage may be disabled or contain an older invalid value. */ }
  return normalizeEqualizerSettings(null);
}

export function normalizeEqualizerSettings(value: unknown): EqualizerSettings {
  const stored = value as Partial<EqualizerSettings> | null;
  const bandCount = stored?.bandCount === 3 || stored?.bandCount === 10 ? stored.bandCount : 5;
  const preset = stored?.preset;
  return {
    bandCount, preset: preset && (preset === "Custom" || Object.hasOwn(EQ_PRESETS, preset)) ? preset : "Flat",
    custom: cleanBands(stored?.custom, bandCount), mode: stored?.mode === "parametric" ? "parametric" : "graphic",
    parametric: cleanParametricBands(stored?.parametric),
    enabled: stored?.enabled === true,
    graphicCustomEnabled: stored?.graphicCustomEnabled === true,
    graphicCustom: cleanCustomGraphicBands(stored?.graphicCustom),
  };
}

function cleanCustomGraphicBands(values: unknown): GraphicBand[] {
  if (!Array.isArray(values) || !values.length) return [...DEFAULT_GRAPHIC_BANDS];
  return Array.from(values.slice(0, MAX_CUSTOM_GRAPHIC_BANDS), band => ({
    frequency: Number.isFinite(band?.frequency)
      ? Math.round(Math.max(EQ_LIMITS.frequency.min, Math.min(EQ_LIMITS.frequency.max, band.frequency))) : 1000,
    gain: Number.isFinite(band?.gain) ? Math.max(-MAX_BOOST, Math.min(MAX_BOOST, band.gain)) : 0,
  }));
}

export function cleanParametricBands(values: unknown): ParametricBand[] {
  const bands = Array.isArray(values) && values.length ? values.slice(0, MAX_PARAMETRIC_BANDS)
    : EQ_FREQUENCIES[5].map(frequency => ({ frequency }));
  return Array.from(bands, (band, index) => {
    const frequency = EQ_FREQUENCIES[5][index] ?? DEFAULT_PARAMETRIC_BAND.frequency;
    const read = (key: keyof typeof EQ_LIMITS, fallback: number) => {
      const value = band?.[key];
      const { min, max } = EQ_LIMITS[key];
      return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    };
    return {
      type: typeof band?.type === "string" && Object.hasOwn(PARAMETRIC_FILTER_TYPES, band.type) ? band.type : "peaking",
      frequency: read("frequency", frequency), gain: read("gain", 0), q: read("q", 1),
    };
  });
}

export function saveEqualizerSettings(settings: EqualizerSettings): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function equalizerBands(settings: EqualizerSettings): readonly number[] {
  if (settings.graphicCustomEnabled) {
    const bands = settings.graphicCustom ?? DEFAULT_GRAPHIC_BANDS;
    return settings.preset === "Custom" ? bands.map(band => band.gain)
      : interpolateGains(EQ_PRESETS[settings.preset], EQ_FREQUENCIES[5], bands.map(band => band.frequency));
  }
  return settings.preset === "Custom" ? settings.custom : remapBands(EQ_PRESETS[settings.preset], 5, settings.bandCount);
}

export function remapBands(gains: readonly number[], from: EqualizerBandCount, to: EqualizerBandCount): readonly number[] {
  if (from === to) return gains;
  return interpolateGains(gains, EQ_FREQUENCIES[from], EQ_FREQUENCIES[to]);
}

function interpolateGains(gains: readonly number[], source: readonly number[], target: readonly number[]): number[] {
  return target.map(frequency => {
    const upper = source.findIndex(center => center >= frequency);
    if (upper === -1) return gains[source.length - 1];
    if (upper === 0) return gains[0];
    const lower = source[upper - 1];
    const fraction = Math.log(frequency / lower) / Math.log(source[upper] / lower);
    return Math.round(2 * (gains[upper - 1] + fraction * (gains[upper] - gains[upper - 1]))) / 2;
  });
}

/** Boosts can overlap. Budget for their sum, with 1 dB reserved above it. */
export function equalizerHeadroomDb(bands: readonly number[]): number {
  const boost = bands.reduce((sum, gain) => sum + Math.max(0, gain), 0);
  return boost > 0 ? -boost - 1 : 0;
}

export function parametricBoost(band: ParametricBand): number {
  if (filterUsesGain(band.type)) return Math.max(0, band.gain);
  if ((band.type === "lowpass" || band.type === "highpass") && band.q > Math.SQRT1_2) {
    // Peak magnitude of a resonant second-order pass filter.
    return 20 * Math.log10(band.q / Math.sqrt(1 - 1 / (4 * band.q ** 2)));
  }
  return 0;
}

function protectionCurve() {
  const width = LIMITER_CEILING - LIMITER_KNEE;
  return Float32Array.from({ length: 16385 }, (_, index) => {
    const sample = (index / 8192 - 1) * LIMITER_INPUT_RANGE;
    const magnitude = Math.abs(sample);
    if (magnitude <= LIMITER_KNEE) return sample;
    return Math.sign(sample) * (LIMITER_KNEE + width * Math.tanh((magnitude - LIMITER_KNEE) / width));
  });
}

/** Shared EQ bus. Floating-point samples stay linear below the protection knee. */
export class EqualizerEngine {
  readonly input: GainNode;
  private filters: BiquadFilterNode[] = [];
  private processing: { scale: GainNode; limiter: WaveShaperNode; curve: ReturnType<typeof protectionCurve> } | null = null;
  private analyser: AnalyserNode | null = null;

  constructor(private readonly context: BaseAudioContext, private readonly destination: AudioNode) {
    this.input = context.createGain();
    this.input.connect(destination);
  }

  setBands(values: readonly number[], bandCount: EqualizerBandCount = 5): void {
    const bands = cleanBands(values, bandCount);
    this.applyFilters(EQ_FREQUENCIES[bandCount].map((frequency, index) => ({
      frequency, gain: bands[index], q: 1,
      type: index === 0 ? "lowshelf" : index === bandCount - 1 ? "highshelf" : "peaking",
    })));
  }

  setSettings(settings: EqualizerSettings): void {
    if (!settings.enabled) {
      if (this.processing) {
        this.dispose();
        this.input.gain.setValueAtTime(1, this.context.currentTime);
        this.input.connect(this.destination);
      }
      return;
    }
    if (settings.mode === "parametric") this.applyFilters(cleanParametricBands(settings.parametric));
    else if (settings.graphicCustomEnabled) {
      const gains = equalizerBands(settings);
      this.applyFilters((settings.graphicCustom ?? DEFAULT_GRAPHIC_BANDS).map((band, index) => ({
        frequency: band.frequency, gain: gains[index], type: "peaking", q: 1,
      })));
    } else this.setBands(equalizerBands(settings), settings.bandCount);
  }

  getAnalyser(): AnalyserNode | null {
    if (!this.processing) return null;
    if (!this.analyser) {
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 4096;
      this.processing.limiter.connect(this.analyser);
    }
    return this.analyser;
  }

  private applyFilters(configs: readonly ParametricBand[]): void {
    if (!this.processing) {
      const scale = this.context.createGain();
      const limiter = this.context.createWaveShaper();
      scale.connect(limiter);
      limiter.connect(this.destination);
      this.processing = { scale, limiter, curve: protectionCurve() };
    }
    const { scale, limiter, curve } = this.processing;
    if (this.filters.length !== configs.length) {
      const filters = configs.map(() => this.context.createBiquadFilter());
      this.input.disconnect();
      this.filters.forEach(filter => filter.disconnect());
      this.filters = filters;
      const chain = [this.input, ...filters, scale];
      for (let index = 0; index < chain.length - 1; index++) chain[index].connect(chain[index + 1]);
    }
    const bands = configs.map(config => filterUsesGain(config.type) ? config.gain : 0);
    const enabled = configs.some((config, index) => !filterUsesGain(config.type) || bands[index] !== 0);
    const time = this.context.currentTime;
    this.input.gain.setValueAtTime(10 ** (equalizerHeadroomDb(configs.map(parametricBoost)) / 20), time);
    this.filters.forEach((filter, index) => {
      const { type, frequency } = configs[index];
      filter.type = type;
      filter.frequency.setValueAtTime(Math.min(frequency, this.context.sampleRate * 0.49), time);
      filter.Q.setValueAtTime(webAudioFilterQ(configs[index]), time);
      filter.gain.setValueAtTime(bands[index], time);
    });
    scale.gain.setValueAtTime(enabled ? 1 / LIMITER_INPUT_RANGE : 1, time);
    limiter.curve = enabled ? curve : null;
  }

  dispose(): void {
    this.input.disconnect();
    this.filters.forEach(filter => filter.disconnect());
    this.processing?.scale.disconnect();
    this.processing?.limiter.disconnect();
    this.analyser?.disconnect();
    this.filters = [];
    this.processing = null;
    this.analyser = null;
  }
}
