import { useEffect, useId, useRef, useState } from "react";
import {
  SMART_FIELDS, LEGACY_SMART_FIELDS, smartFieldInfo, SMART_OPERATORS, operatorsFor,
  type SmartField, type SmartGroup, type SmartNode, type SmartOperator,
  type SmartPlaylist, type SmartPreview, type SmartRule,
} from "../api/smartPlaylists";
import { createSmartPlaylist, previewSmartPlaylist, updateSmartPlaylist } from "../api/musicdeck";
import "../styles/smart-playlists.css";
import SmartPlaylistSongPicker from "./SmartPlaylistSongPicker";

const newRule = (): SmartRule => ({ field: "genre", operator: "contains", value: "" });
const newGroup = (): SmartGroup => ({ operator: "AND", rules: [newRule()] });
const isField = (value: string): value is SmartField => SMART_FIELDS.some((field) => field.id === value);
const isOperator = (value: string): value is SmartOperator => Object.prototype.hasOwnProperty.call(SMART_OPERATORS, value);
const daysOperator = (operator: SmartOperator) => operator === "in_last_days" || operator === "not_in_last_days";
const countNodes = (node: SmartNode): number => 1 + ("rules" in node ? node.rules.reduce((sum, child) => sum + countNodes(child), 0) : 0);

function defaultRule(field: SmartField): SmartRule {
  if (field === "similar_to") return { field, operator: "matches", value: "" };
  if (field === "is_favorite") return { field, operator: "equals", value: true };
  if (field === "last_played") return { field, operator: "not_in_last_days", value: 30 };
  const numeric = smartFieldInfo(field).kind === "number";
  return { field, operator: operatorsFor(field)[0], value: numeric ? 0 : "" };
}

function inputIssue(node: SmartNode, depth = 0): string | null {
  if (depth > 6 || countNodes(node) > 100) return "Use at most 100 rules and 6 nested levels.";
  if ("rules" in node) {
    if (!node.rules.length) return "Add at least one condition to every group.";
    return node.rules.map((child) => inputIssue(child, depth + 1)).find(Boolean) || null;
  }
  if (typeof node.value === "string" && !node.value.trim()) return "Complete each condition to preview matching tracks.";
  if (node.field === "is_favorite") return typeof node.value === "boolean" ? null : "Choose Yes or No for Favorite.";
  const numeric = smartFieldInfo(node.field).kind === "number" || daysOperator(node.operator);
  if (numeric && (typeof node.value !== "number" || !Number.isFinite(node.value) || node.value < 0 ||
    (node.field !== "bpm" && !Number.isInteger(node.value)))) return "Use a non-negative number (whole numbers except for BPM).";
  if (daysOperator(node.operator) && (Number(node.value) < 1 || Number(node.value) > 36500)) return "Choose between 1 and 36,500 days.";
  return null;
}

function RuleEditor({ rule, path, onChange, onRemove, disabled }: {
  rule: SmartRule; path: string; onChange(rule: SmartRule): void; onRemove(): void; disabled: boolean;
}) {
  const relative = daysOperator(rule.operator);
  const kind = smartFieldInfo(rule.field).kind;
  const date = kind === "date" && !relative;
  return <div className="smart-rule-row">
    <select aria-label={`Field ${path}`} value={rule.field} disabled={disabled}
      onChange={(event) => { if (isField(event.target.value)) onChange(defaultRule(event.target.value)); }}>
      {SMART_FIELDS.map((field) => <option key={field.id} value={field.id}>{field.label}</option>)}
      {LEGACY_SMART_FIELDS.filter((field) => field.id === rule.field).map((field) => <option key={field.id} value={field.id}>{field.label}</option>)}
    </select>
    {kind === "song" ? <span className="smart-rule-operator">to</span> : <select aria-label={`Operator ${path}`} value={rule.operator} disabled={disabled}
      onChange={(event) => {
        const operator = event.target.value;
        if (!isOperator(operator)) return;
        const value = rule.field === "last_played" && daysOperator(rule.operator) !== daysOperator(operator)
          ? daysOperator(operator) ? 30 : new Date().toISOString() : rule.value;
        onChange({ ...rule, operator, value });
      }}>
      {[...new Set([...operatorsFor(rule.field), rule.operator])].map((operator) => <option key={operator} value={operator}>
        {rule.field === "last_played" && operator === "greater_than" ? "after"
          : rule.field === "last_played" && operator === "less_than" ? "before" : SMART_OPERATORS[operator]}
      </option>)}
    </select>}
    {kind === "song" ? <SmartPlaylistSongPicker path={path} value={String(rule.value)} disabled={disabled}
      onChange={(value) => onChange({ ...rule, value })} /> : kind === "boolean" ? <select aria-label={`Value ${path}`} value={String(rule.value)} disabled={disabled}
      onChange={(event) => onChange({ ...rule, value: event.target.value === "true" })}>
      <option value="true">Yes</option><option value="false">No</option>
    </select> : <div className="smart-rule-value">
      <input aria-label={`Value ${path}`} disabled={disabled}
        type={date ? "datetime-local" : kind === "number" || relative ? "number" : "text"}
        min={relative ? 1 : kind === "number" ? 0 : undefined}
        max={relative ? 36500 : undefined} step={rule.field === "bpm" ? "any" : 1}
        maxLength={kind === "text" ? 300 : undefined}
        value={date ? (() => {
          const value = new Date(String(rule.value));
          return Number.isNaN(value.getTime()) ? "" : new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        })() : String(rule.value)}
        placeholder={rule.field === "genre" ? "e.g. Synthwave" : "Value"}
        onChange={(event) => {
          const value = event.target.value;
          onChange({ ...rule, value: date ? value ? new Date(value).toISOString() : ""
            : kind === "number" || relative ? value === "" ? "" : Number(value) : value });
        }} />
      {relative && <span>days</span>}
    </div>}
    <button type="button" className="smart-remove" disabled={disabled} onClick={onRemove}
      aria-label={`Remove condition ${path}`}>Remove</button>
    {kind === "song" && <p className="smart-rule-help">Finds other library songs by the same artist, or with a shared genre and similar tempo when tagged. Excludes the song you choose.</p>}
  </div>;
}

function GroupEditor({ group, path, depth, canAdd, onChange, onRemove, disabled }: {
  group: SmartGroup; path: string; depth: number; canAdd: boolean; disabled: boolean;
  onChange(group: SmartGroup): void; onRemove?: () => void;
}) {
  return <fieldset className="smart-rule-group" disabled={disabled}>
    <legend>{depth ? `Nested group ${path}` : "Track conditions"}</legend>
    <div className="smart-group-heading">
      <label>Match <select aria-label={`Match ${path}`} value={group.operator} onChange={(event) => {
        if (event.target.value === "AND" || event.target.value === "OR") onChange({ ...group, operator: event.target.value });
      }}><option value="AND">all conditions</option><option value="OR">any condition</option></select></label>
      {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove group ${path}`}>Remove group</button>}
    </div>
    {group.rules.map((node, index) => {
      const childPath = `${path}.${index + 1}`;
      const change = (next: SmartNode) => onChange({ ...group, rules: group.rules.map((item, i) => i === index ? next : item) });
      const remove = () => onChange({ ...group, rules: group.rules.filter((_, i) => i !== index) });
      return "rules" in node
        ? <GroupEditor key={index} group={node} path={childPath} depth={depth + 1} canAdd={canAdd} disabled={disabled}
          onChange={change} onRemove={remove} />
        : <RuleEditor key={index} rule={node} path={childPath} disabled={disabled} onChange={change} onRemove={remove} />;
    })}
    <div className="smart-add-actions">
      <button type="button" disabled={!canAdd || depth >= 6} onClick={() => onChange({ ...group, rules: [...group.rules, newRule()] })}
        aria-label={`Add condition to ${path}`}>+ Condition</button>
      <button type="button" disabled={!canAdd || depth >= 5} onClick={() => onChange({ ...group, rules: [...group.rules, newGroup()] })}
        aria-label={`Add group to ${path}`}>+ Nested group</button>
    </div>
  </fieldset>;
}

function friendlyError(error: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "You're offline. Reconnect to preview or save this playlist.";
  if (error instanceof TypeError) return "Can't reach MusicDeck. Check your connection and try again.";
  return error instanceof Error ? error.message : "Could not update the smart playlist. Try again.";
}

/** Debounced, abortable previews never let an older response describe newer
 * conditions. Saving persists the AST, not the currently previewed track IDs. */
export default function LegacySmartPlaylistBuilder({ playlist, onSaved, onBusyChange }: {
  playlist?: SmartPlaylist; onSaved?(playlist: SmartPlaylist): void; onBusyChange?(busy: boolean): void;
}) {
  const nameId = useId();
  const [name, setName] = useState(playlist?.name || "");
  const [recordId, setRecordId] = useState(playlist?.id);
  const [root, setRoot] = useState<SmartGroup>(() => playlist?.rules
    ? "rules" in playlist.rules ? playlist.rules : { operator: "AND", rules: [playlist.rules] } : newGroup());
  const [preview, setPreview] = useState<{ key: string; result: SmartPreview } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const issue = inputIssue(root);
  const key = JSON.stringify(root);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBusyChange?.(saving); }, [saving, onBusyChange]);
  useEffect(() => {
    const revision = ++sequence.current;
    const controller = new AbortController();
    setPreviewError("");
    if (issue) return () => controller.abort();
    const timer = window.setTimeout(() => {
      previewSmartPlaylist(JSON.parse(key), controller.signal).then((result: SmartPreview) => {
        if (!controller.signal.aborted && sequence.current === revision) setPreview({ key, result });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted && sequence.current === revision) setPreviewError(friendlyError(error));
      });
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, issue, retry]);

  async function save() {
    if (savingRef.current || issue || !name.trim()) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    setSaved("");
    try {
      const payload = { name: name.trim(), rules: root };
      const result: { playlist: SmartPlaylist } = await (recordId
        ? updateSmartPlaylist(recordId, payload) : createSmartPlaylist(payload));
      if (!mounted.current) return;
      setSaved(`Saved "${result.playlist.name}". Matching tracks update automatically.`);
      setRecordId(result.playlist.id);
      window.dispatchEvent(new Event("smartPlaylistsChanged"));
      onSaved?.(result.playlist);
    } catch (error) {
      if (mounted.current) setSaveError(friendlyError(error));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  const result = preview?.key === key && !previewError ? preview.result : null;
  const resultCount = result ? `${result.total.toLocaleString()} matching ${result.total === 1 ? "track" : "tracks"}` : "";
  return <section className="smart-playlist-builder" aria-label="Smart playlist builder">
    <div className="smart-builder-heading">
      <p>Pick what belongs here. Matching songs from your library update automatically.</p></div>
    {!playlist && <div className="smart-starters" role="group" aria-label="Start with a rule">
      <span>Start with</span>
      <button type="button" disabled={saving} onClick={() => setRoot({ operator: "AND", rules: [defaultRule("similar_to")] })}>Similar songs</button>
      <button type="button" disabled={saving} onClick={() => setRoot({ operator: "AND", rules: [defaultRule("is_favorite")] })}>Liked songs</button>
      <button type="button" disabled={saving} onClick={() => setRoot({ operator: "AND", rules: [defaultRule("last_played")] })}>Not played recently</button>
    </div>}
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="smart-name" htmlFor={nameId}>Playlist name
        <input id={nameId} value={name} required maxLength={200} disabled={saving}
          onChange={(event) => { setName(event.target.value); setSaved(""); }} placeholder="e.g. Synthwave, rediscovered" />
      </label>
      <GroupEditor group={root} path="1" depth={0} canAdd={countNodes(root) < 99} disabled={saving}
        onChange={(next) => { setRoot(next); setSaved(""); }} />
      <p className="smart-builder-note">Uses songs already in your library. Likes and listening history are personal to your account.
        “Not within the last” also includes songs you have never played.</p>
      {issue && <p role="status" className="smart-builder-note">{issue}</p>}
      {saveError && <p role="alert">{saveError}</p>}
      {saved && <p role="status">{saved}</p>}
      <button type="submit" className="smart-primary" disabled={saving || Boolean(issue) || !name.trim()}>
        {saving ? "Saving..." : recordId ? "Save changes" : "Create smart playlist"}
      </button>
    </form>
    <aside className="smart-preview" aria-label="Preview Results" aria-busy={!issue && !result && !previewError}>
      <div className="smart-preview-heading"><h3>Matching songs</h3>
        <span>{result ? resultCount : issue ? "Complete your rules" : previewError ? "Preview unavailable" : "Updating..."}</span>
      </div>
      {previewError && <div role="alert">{previewError}
        <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry preview</button>
      </div>}
      {result?.warning && <p role="status">{result.warning}</p>}
      {result?.refreshedAt && <p className="smart-builder-note">Catalog updated {new Date(result.refreshedAt).toLocaleString()}</p>}
      {result && <div role="status" className="smart-preview-count">{resultCount}</div>}
      {result?.tracks.length ? <ol>{result.tracks.map((track) => <li key={track.id}>
        <strong>{track.title}</strong><span>{track.artist}{track.album ? ` / ${track.album}` : ""}</span>
      </li>)}</ol> : result && <p>No tracks match yet. Try broadening a condition.</p>}
      <p className="smart-builder-note">Showing up to 12 sample tracks. Conditions are evaluated again whenever you open or play the collection.</p>
      <button type="button" disabled={Boolean(issue)} onClick={() => setRetry((value) => value + 1)}>Refresh preview</button>
    </aside>
  </section>;
}
