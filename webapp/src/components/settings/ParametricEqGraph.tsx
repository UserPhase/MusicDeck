import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { EQ_LIMITS, filterUsesGain, webAudioFilterQ, type ParametricBand } from "../../services/audio/EqualizerEngine";

const { min: minHz, max: maxHz } = EQ_LIMITS.frequency;
const frequencySpan = Math.log(maxHz / minHz);
const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const gainTicks = [12, 6, 0, -6, -12];
const width = 1000;
const height = 300;
const x = (hz: number) => Math.log(hz / minHz) / frequencySpan;
const y = (gain: number) => (12 - gain) / 24;
const pointGain = (band: ParametricBand) => filterUsesGain(band.type) ? band.gain : 0;
const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

function makePreview(sampleRate: number, count: number) {
  try {
    const context = new OfflineAudioContext(1, 1, sampleRate);
    return Array.from({ length: count }, () => context.createBiquadFilter());
  } catch {
    return null;
  }
}

function responsePaths(nodes: BiquadFilterNode[], bands: readonly ParametricBand[], active: number, sampleRate: number) {
  const count = 320;
  const ceiling = sampleRate * 0.49;
  const frequencies = Float32Array.from({ length: count }, (_, index) =>
    Math.min(ceiling, minHz * Math.exp(frequencySpan * index / (count - 1))));
  const magnitude = new Float32Array(count);
  const phase = new Float32Array(count);
  const total = new Float32Array(count);
  const path = (values: Float32Array) => Array.from(values, (value, index) =>
    `${index ? "L" : "M"}${(index * width / (count - 1)).toFixed(1)} ${(y(value) * height).toFixed(1)}`).join(" ");
  let selected = "";
  nodes.forEach((node, index) => {
    const band = bands[index];
    node.type = band.type;
    node.frequency.value = Math.min(ceiling, band.frequency);
    node.Q.value = webAudioFilterQ(band);
    node.gain.value = pointGain(band);
    node.getFrequencyResponse(frequencies, magnitude, phase);
    magnitude.forEach((value, bin) => {
      const db = 20 * Math.log10(Math.max(value, 0.000001));
      total[bin] += db;
      magnitude[bin] = db;
    });
    if (index === active) selected = path(magnitude);
  });
  return { total: path(total), selected };
}

type Drag = { pointer: number; startX: number; startY: number; width: number; height: number; moved: boolean };
type BandPosition = Pick<ParametricBand, "frequency" | "gain">;

function Spectrum({ getAnalyser }: { getAnalyser(): AnalyserNode | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const analyser = getAnalyser();
    if (!canvas || !analyser) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const binWidth = analyser.context.sampleRate / analyser.fftSize;
    const points = Array.from({ length: 160 }, (_, index) => Math.min(bins.length - 1,
      Math.round(minHz * Math.exp(frequencySpan * index / 159) / binWidth)));
    let frame = 0;
    let last = -Infinity;
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      if (time - last < 32) return;
      last = time;
      const density = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(canvas.clientWidth * density), height = Math.round(canvas.clientHeight * density);
      if (!width || !height) return;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      analyser.getByteFrequencyData(bins);
      context.clearRect(0, 0, width, height);
      context.beginPath();
      context.moveTo(0, height);
      points.forEach((bin, index) => context.lineTo(index * width / 159, height * (1 - bins[bin] / 255)));
      context.lineTo(width, height);
      context.fillStyle = getComputedStyle(canvas).color;
      context.fill();
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [getAnalyser]);
  return <canvas ref={ref} className="eq-spectrum" aria-hidden="true" />;
}

export default function ParametricEqGraph({ bands, active, sampleRate, onSelect, onChange, getAnalyser }: {
  bands: readonly ParametricBand[];
  active: number;
  sampleRate: number;
  onSelect(index: number): void;
  onChange(index: number, position: BandPosition): void;
  getAnalyser(): AnalyserNode | null;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ index: number; position: BandPosition } | null>(null);
  const filters = useMemo(() => makePreview(sampleRate, bands.length), [sampleRate, bands.length]);
  const visible = useMemo(() => preview ? bands.map((band, index) => index === preview.index ? { ...band, ...preview.position } : band) : bands, [bands, preview]);
  const paths = useMemo(() => filters ? responsePaths(filters, visible, active, sampleRate) : null, [filters, visible, active, sampleRate]);

  function position(event: PointerEvent<HTMLButtonElement>, state: Drag, band: ParametricBand): BandPosition {
    return {
      frequency: Math.round(minHz * Math.exp(frequencySpan * clampUnit((event.clientX - state.startX) / state.width))),
      gain: filterUsesGain(band.type)
        ? Math.round((12 - 24 * clampUnit((event.clientY - state.startY) / state.height)) * 2) / 2 : band.gain,
    };
  }

  return <div className="eq-response-chart">
    <div className="eq-response-y" aria-hidden="true">{gainTicks.map(gain =>
      <span key={gain} style={{ top: `${y(gain) * 100}%` }}>{gain > 0 ? "+" : ""}{gain} dB</span>)}</div>
    <div ref={plot} className={`eq-response-plot eq-band-color-${active + 1}`} role="group" aria-label="Parametric EQ response">
      <Spectrum getAnalyser={getAnalyser} />
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        {ticks.map(hz => <line key={hz} x1={x(hz) * width} x2={x(hz) * width} y1="0" y2={height} />)}
        {gainTicks.map(gain => <line key={gain} className={gain === 0 ? "eq-response-zero" : undefined}
          x1="0" x2={width} y1={y(gain) * height} y2={y(gain) * height} />)}
        {paths && <>
          <path className="eq-response-selected" d={paths.selected} />
          <path className="eq-response-total" d={paths.total} />
        </>}
      </svg>
      {visible.map((band, index) => <button key={index} type="button"
        className={`eq-response-point eq-band-color-${index + 1}`} aria-label={`Select EQ band ${index + 1}`}
        aria-pressed={index === active} style={{ left: `${x(band.frequency) * 100}%`, top: `${y(pointGain(band)) * 100}%` }}
        onClick={() => onSelect(index)}
        onPointerDown={event => {
          if (event.button !== 0 || drag.current || !plot.current) return;
          const bounds = plot.current.getBoundingClientRect();
          drag.current = { pointer: event.pointerId, width: bounds.width, height: bounds.height, moved: false,
            startX: event.clientX - x(band.frequency) * bounds.width, startY: event.clientY - y(pointGain(band)) * bounds.height };
          event.currentTarget.setPointerCapture(event.pointerId);
          onSelect(index);
        }}
        onPointerMove={event => {
          const state = drag.current;
          if (state?.pointer === event.pointerId) {
            state.moved = true;
            setPreview({ index, position: position(event, state, band) });
          }
        }}
        onPointerUp={event => {
          const state = drag.current;
          if (state?.pointer !== event.pointerId) return;
          const next = position(event, state, band);
          drag.current = null;
          setPreview(null);
          if (state.moved && (next.frequency !== bands[index].frequency || next.gain !== bands[index].gain)) onChange(index, next);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setPreview(null);
        }}><span aria-hidden="true" /></button>)}
    </div>
    <div className="eq-response-x" aria-hidden="true">{ticks.map(hz =>
      <span key={hz} style={{ left: `${x(hz) * 100}%` }}>{hz < 1000 ? hz : `${hz / 1000}k`}</span>)}</div>
  </div>;
}
