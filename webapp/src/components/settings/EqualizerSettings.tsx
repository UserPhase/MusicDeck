import { useCallback, useId, useState } from "react";
import type { PlaybackEngine } from "../../services/audio/PlaybackEngine";
import {
  DEFAULT_GRAPHIC_BANDS, DEFAULT_PARAMETRIC_BAND, EQ_FREQUENCIES, EQ_LIMITS, EQ_PRESETS,
  MAX_CUSTOM_GRAPHIC_BANDS, MAX_PARAMETRIC_BANDS, PARAMETRIC_FILTER_TYPES,
  cleanParametricBands, equalizerBands, equalizerHeadroomDb, filterUsesGain, filterUsesQ, parametricBoost, remapBands,
  type EqualizerBandCount, type EqualizerPreset, type EqualizerSettings as Settings, type ParametricBand,
} from "../../services/audio/EqualizerEngine";
import "../../styles/audio-tools.css";
import ParametricEqGraph from "./ParametricEqGraph";
import EqualizerPresets from "./EqualizerPresets";

const presets = [...Object.keys(EQ_PRESETS), "Custom"] as EqualizerPreset[];
const signed = (gain: number) => `${gain > 0 ? "+" : ""}${gain} dB`;
const parametricFields = { frequency: "Frequency (Hz)", gain: "Gain (dB)", q: "Q" } as const;
const defaultParametricBands = cleanParametricBands(null);

export default function EqualizerSettings({ engine, local, playing = false }: {
  engine: PlaybackEngine; local: boolean; playing?: boolean;
}) {
  const heading = useId();
  const [settings, setSettings] = useState(() => engine.getEqualizerSettings());
  const [notice, setNotice] = useState("");
  const [selectedBand, setSelectedBand] = useState(0);
  const enabled = settings.enabled === true;
  const bands = equalizerBands(settings);
  const customGraphic = settings.graphicCustomEnabled;
  const graphicBands = settings.graphicCustom ?? DEFAULT_GRAPHIC_BANDS;
  const graphicFrequencies = customGraphic ? graphicBands.map(band => band.frequency) : EQ_FREQUENCIES[settings.bandCount];
  const parametric = settings.mode === "parametric";
  const parametricBands = settings.parametric ?? defaultParametricBands;
  const gains = parametric ? parametricBands.map(parametricBoost) : bands;
  const available = local && engine.equalizerAvailable;
  const getAnalyser = useCallback(() => enabled && available ? engine.getEqualizerAnalyser?.() ?? null : null, [enabled, available, engine]);
  function change(next: Settings) {
    try {
      const saved = engine.setEqualizerSettings({ ...next, parametric: next.parametric ?? defaultParametricBands });
      setSettings(engine.getEqualizerSettings());
      setNotice(saved ? "" : "Applied for this session. Browser storage is unavailable.");
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not apply equalizer settings.");
      return false;
    }
  }
  function updateBand(index: number, update: Partial<ParametricBand>) {
    change({ ...settings, parametric: parametricBands.map((band, position) => position === index ? { ...band, ...update } : band) });
  }
  return <section className="settings-equalizer" aria-labelledby={heading}>
    <div className="eq-heading">
      <div className="settings-row-copy">
        <h3 id={heading}>Equalizer</h3>
        <p>Shape the sound on this device. Changes save automatically.</p>
      </div>
      <label className="settings-switch">
        <input type="checkbox" role="switch" aria-label="Enable equalizer" checked={enabled}
          onChange={event => change({ ...settings, enabled: event.target.checked })} />
        <span aria-hidden="true" />
      </label>
    </div>
    {enabled && <>
    {!available && <p className="settings-inline-message">These settings apply to local Web Audio playback.</p>}
    <fieldset className="audio-tools-fields" aria-labelledby={heading}>
      <div className="eq-options">
        <label className="settings-select-control"><span>Equalizer mode</span>
          <select value={settings.mode ?? "graphic"} onChange={event => change({ ...settings, mode: event.target.value === "parametric" ? "parametric" : "graphic" })}>
            <option value="graphic">Graphic EQ</option>
            <option value="parametric">Parametric EQ</option>
          </select>
        </label>
        {!parametric && <>
          <label className="settings-select-control"><span>Equalizer bands</span>
            <select value={customGraphic ? "custom" : settings.bandCount} onChange={event => {
              if (event.target.value === "custom") {
                change({ ...settings, graphicCustomEnabled: true });
                return;
              }
              const bandCount = Number(event.target.value) as EqualizerBandCount;
              change({ ...settings, graphicCustomEnabled: false, bandCount, custom: remapBands(settings.custom, settings.bandCount, bandCount) });
            }}>
              <option value={3}>3 bands · Bass, mid, treble</option>
              <option value={5}>5 bands · Classic</option>
              <option value={10}>10 bands · Octave</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="settings-select-control"><span>Equalizer preset</span>
            <select value={settings.preset} onChange={event => change({ ...settings, preset: event.target.value as EqualizerPreset })}>
              {presets.map(preset => <option key={preset}>{preset}</option>)}
            </select>
          </label>
        </>}
        {parametric && <label className="settings-select-control"><span>Factory preset</span>
          <select value="" onChange={event => {
            const preset = event.target.value as keyof typeof EQ_PRESETS;
            if (!Object.hasOwn(EQ_PRESETS, preset)) return;
            setSelectedBand(0);
            change({ ...settings, parametric: EQ_FREQUENCIES[5].map((frequency, index) => ({
              frequency, gain: EQ_PRESETS[preset][index], q: 1,
              type: index === 0 ? "lowshelf" : index === 4 ? "highshelf" : "peaking",
            })) });
          }}>
            <option value="">Factory presets</option>
            {Object.keys(EQ_PRESETS).map(preset => <option key={preset}>{preset}</option>)}
          </select>
        </label>}
      </div>
      {parametric ? <div className="eq-parametric">
        <p>Drag a point to adjust its frequency and, where supported, gain. Use Q to adjust width or resonance.</p>
        <ParametricEqGraph bands={parametricBands} active={selectedBand}
          sampleRate={engine.getAudioDiagnostics?.().sampleRateHz ?? 48000}
          onSelect={setSelectedBand} onChange={updateBand} getAnalyser={getAnalyser} playing={playing} />
        <div className="eq-band-picker" role="group" aria-label="Choose a band to edit">
          {parametricBands.map((_, index) => <button key={index} type="button"
            className={`eq-band-color-${index + 1}`} aria-pressed={index === selectedBand}
            onClick={() => setSelectedBand(index)}>Band {index + 1}</button>)}
        </div>
        <div className="eq-band-actions">
          <span>{parametricBands.length} of {MAX_PARAMETRIC_BANDS} bands</span>
          <button type="button" className="account-secondary" disabled={parametricBands.length >= MAX_PARAMETRIC_BANDS}
            onClick={() => {
              if (change({ ...settings, parametric: [...parametricBands, DEFAULT_PARAMETRIC_BAND] })) {
                setSelectedBand(parametricBands.length);
              }
            }}>Add band</button>
          <button type="button" className="account-secondary" disabled={parametricBands.length <= 1}
            onClick={() => {
              if (change({ ...settings, parametric: parametricBands.filter((_, index) => index !== selectedBand) })) {
                setSelectedBand(Math.min(selectedBand, parametricBands.length - 2));
              }
            }}>Remove band {selectedBand + 1}</button>
        </div>
        {parametricBands.map((band, index) => index === selectedBand && <fieldset className="eq-parametric-band" key={index}>
          <legend>Band {index + 1}</legend>
          <label>Filter
            <select aria-label={`Band ${index + 1} filter`} value={band.type}
              onChange={event => updateBand(index, { type: event.target.value as ParametricBand["type"] })}>
              {Object.entries(PARAMETRIC_FILTER_TYPES).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
            </select>
          </label>
          {(Object.entries(parametricFields) as [keyof typeof parametricFields, string][]).map(([field, label]) => (
            <label key={field}>{label}
              <input key={band[field]} type="number" {...EQ_LIMITS[field]} defaultValue={band[field]}
                aria-label={`Band ${index + 1} ${label}`}
                disabled={(field === "q" && !filterUsesQ(band.type)) || (field === "gain" && !filterUsesGain(band.type))}
                onBlur={event => {
                  const { min, max, step } = EQ_LIMITS[field];
                  const value = event.currentTarget.valueAsNumber;
                  const snapped = Number((Math.round(value / step) * step).toFixed(1));
                  const next = Number.isFinite(snapped) ? Math.max(min, Math.min(max, snapped)) : band[field];
                  event.currentTarget.value = String(next);
                  if (next !== band[field]) updateBand(index, { [field]: next });
                }}
                onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
            </label>
          ))}
        </fieldset>)}
      </div> : <>
      <div className={`eq-plot${customGraphic ? " eq-plot-custom" : ""}`}>
        <div className="eq-scale" aria-hidden="true"><span>+12</span><span>0 dB</span><span>−12</span></div>
        <div className="eq-bands">
          {graphicFrequencies.map((frequency, index) => {
            const label = frequency >= 1000 ? `${frequency / 1000} kHz` : `${frequency} Hz`;
            return <div key={index} className="eq-band">
              <input type="range" min="-12" max="12" step="0.5" value={bands[index]}
                aria-label={customGraphic ? `Graphic band ${index + 1} gain` : label} aria-orientation="vertical" aria-valuetext={signed(bands[index])}
                onChange={event => {
                  const custom = [...bands];
                  custom[index] = Number(event.target.value);
                  change(customGraphic
                    ? { ...settings, preset: "Custom", graphicCustom: graphicBands.map((band, position) => ({ ...band, gain: custom[position] })) }
                    : { ...settings, preset: "Custom", custom });
                }} />
              {customGraphic ? <label className="eq-custom-frequency">
                <input key={frequency} type="number" {...EQ_LIMITS.frequency} defaultValue={frequency}
                  aria-label={`Graphic band ${index + 1} frequency (Hz)`}
                  onBlur={event => {
                    const value = event.currentTarget.valueAsNumber;
                    const next = Number.isFinite(value) ? Math.round(Math.max(EQ_LIMITS.frequency.min, Math.min(EQ_LIMITS.frequency.max, value))) : frequency;
                    event.currentTarget.value = String(next);
                    if (next !== frequency) change({ ...settings, graphicCustom: graphicBands.map((band, position) =>
                      position === index ? { ...band, frequency: next } : band) });
                  }}
                  onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /> Hz
              </label> : <span className="eq-frequency">{label}</span>}
              <span className="eq-level" aria-hidden="true">{signed(bands[index])}</span>
              {customGraphic && <button type="button" className="account-secondary" aria-label={`Remove graphic band ${index + 1}`}
                disabled={graphicBands.length <= 1} onClick={() => change({
                  ...settings, graphicCustom: graphicBands.filter((_, position) => position !== index),
                })}>Remove</button>}
            </div>;
          })}
        </div>
      </div>
      {customGraphic && <div className="eq-band-actions">
        <span>{graphicBands.length} of {MAX_CUSTOM_GRAPHIC_BANDS} bands</span>
        <button type="button" className="account-secondary" disabled={graphicBands.length >= MAX_CUSTOM_GRAPHIC_BANDS}
          onClick={() => change({ ...settings, graphicCustom: [...graphicBands, { frequency: 1000, gain: 0 }] })}>Add band</button>
      </div>}
      </>}
    </fieldset>
    <EqualizerPresets settings={settings} apply={next => {
      setSelectedBand(0);
      return change({ ...next, enabled });
    }} />
    <div className="eq-headroom">
      <span>Automatic preamp <strong>{signed(Number(equalizerHeadroomDb(gains).toFixed(1)))}</strong></span>
      <button type="button" className="account-secondary" disabled={!parametric && !customGraphic && bands.every(gain => gain === 0)}
        onClick={() => {
          if (parametric) setSelectedBand(0);
          change(parametric ? { ...settings, parametric: cleanParametricBands(null) }
            : customGraphic ? { ...settings, preset: "Flat", graphicCustom: DEFAULT_GRAPHIC_BANDS }
              : { ...settings, preset: "Flat", custom: bands.map(() => 0) });
        }}>Reset EQ</button>
    </div>
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
