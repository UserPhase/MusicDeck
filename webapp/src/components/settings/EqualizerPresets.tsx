import { useState } from "react";
import { normalizeEqualizerSettings, type EqualizerSettings } from "../../services/audio/EqualizerEngine";

const key = "musicdeck:equalizer-presets:v1";
const limit = 30;
type Preset = { name: string; settings: EqualizerSettings };

function readPresets(): Preset[] {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (Array.isArray(data)) return data.filter(item =>
      typeof item?.name === "string" && item.name.trim() && item.name.length <= 40 && item.settings)
      .slice(0, limit).map(item => ({ name: item.name, settings: normalizeEqualizerSettings(item.settings) }));
  } catch { /* Browser storage may be disabled. */ }
  return [];
}

export default function EqualizerPresets({ settings, apply }: {
  settings: EqualizerSettings;
  apply(settings: EqualizerSettings): boolean;
}) {
  const [presets, setPresets] = useState(readPresets);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const trimmed = name.trim();
  const duplicate = presets.find(preset => preset.name.toLowerCase() === trimmed.toLowerCase());

  function save(next: Preset[], selection: string, message: string) {
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setPresets(next);
      setSelected(selection);
      setNotice(message);
    } catch {
      setNotice("Could not save presets on this device.");
    }
  }

  return <fieldset className="eq-parametric-band eq-custom-presets">
    <legend>Custom presets</legend>
    <label>Saved preset
      <select value={selected} onChange={event => {
        const preset = presets.find(item => item.name === event.target.value);
        setSelected(preset?.name ?? "");
        setName(preset?.name ?? "");
        setNotice("");
        if (preset) apply(preset.settings);
      }}>
        <option value="">Choose a preset</option>
        {presets.map(preset => <option key={preset.name}>{preset.name}</option>)}
      </select>
    </label>
    <label>Preset name
      <input value={name} maxLength={40} onChange={event => setName(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} />
    </label>
    <div className="eq-custom-preset-actions">
      <button className="account-secondary" type="button" disabled={!trimmed || Boolean(duplicate) || presets.length >= limit}
        onClick={() => save([...presets, { name: trimmed, settings: normalizeEqualizerSettings(settings) }], trimmed, "Preset saved.")}>Save new</button>
      <button className="account-secondary" type="button" disabled={!selected || !trimmed || trimmed === selected || Boolean(duplicate && duplicate.name !== selected)}
        onClick={() => save(presets.map(preset => preset.name === selected ? { ...preset, name: trimmed } : preset), trimmed, "Preset renamed.")}>Rename</button>
      <button className="account-secondary" type="button" disabled={!selected}
        onClick={() => save(presets.filter(preset => preset.name !== selected), "", "Preset deleted.")}>Delete</button>
    </div>
    {notice && <p role="status">{notice}</p>}
  </fieldset>;
}
