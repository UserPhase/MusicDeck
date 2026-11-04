import { useEffect, useId, useRef, useState } from "react";
import { createSmartPlaylist, previewSmartPlaylist, saveMixPlaylist, updateSmartPlaylist } from "../api/musicdeck";
import type { MixOptions, SmartPlaylist, SmartPreview } from "../api/smartPlaylists";
import { mixIssue, mixRules, newMixRecipe, readMixRecipe, type MixMode } from "../utils/mixRecipe";
import LegacySmartPlaylistBuilder from "./LegacySmartPlaylistBuilder";
import SmartPlaylistSongPicker from "./SmartPlaylistSongPicker";
import "../styles/smart-playlists.css";

type SavedMix = { id: string; name: string };
type Props = { playlist?: SmartPlaylist; onSaved?(playlist: SmartPlaylist, kind?: "playlist" | "smart"): void; onBusyChange?(busy: boolean): void };
const starts: { id: MixMode; symbol: string; title: string; description: string }[] = [
  { id: "similar", symbol: "♫", title: "Similar songs", description: "Start with a song you love." },
  { id: "era", symbol: "◷", title: "An era", description: "Bring a decade back to life." },
  { id: "rediscover", symbol: "↺", title: "Rediscover", description: "Find favourites you haven't heard lately." },
];
const randomSeed = () => Math.floor(Math.random() * 2_147_483_647);
const errorText = (error: unknown) => error instanceof TypeError ? "Can't reach MusicDeck. Your mix is still here; try again."
  : error instanceof Error ? error.message : "Could not save your mix. Try again.";

export default function SmartPlaylistBuilder(props: Props) {
  // Complex older collections keep their original editor and exact saved rules.
  if (props.playlist && !readMixRecipe(props.playlist)) return <LegacySmartPlaylistBuilder {...props} />;
  return <MixMaker {...props} />;
}

function MixMaker({ playlist, onSaved, onBusyChange }: Props) {
  const id = useId();
  const [recipe, setRecipe] = useState(() => playlist ? readMixRecipe(playlist)! : newMixRecipe());
  const [name, setName] = useState(playlist?.name || "");
  const [size, setSize] = useState(playlist?.options?.size || 50);
  const [seed, setSeed] = useState(playlist?.options?.seed ?? randomSeed);
  const [updating, setUpdating] = useState(Boolean(playlist));
  const [recordId, setRecordId] = useState(playlist?.id);
  const [preview, setPreview] = useState<{ key: string; result: SmartPreview } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const sequence = useRef(0);
  const issue = mixIssue(recipe);
  const options: MixOptions = { size, seed, order: recipe.mode === "similar" ? "similar" : recipe.mode === "rediscover" ? "rediscover" : "variety" };
  const key = JSON.stringify({ rules: mixRules(recipe), options });
  const result = preview?.key === key && !previewError ? preview.result : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBusyChange?.(saving); }, [saving, onBusyChange]);
  useEffect(() => {
    const controller = new AbortController();
    const version = ++sequence.current;
    setPreviewError("");
    if (issue) return () => controller.abort();
    const timer = window.setTimeout(() => {
      const request = JSON.parse(key);
      previewSmartPlaylist(request.rules, controller.signal, request.options).then((data: SmartPreview) => {
        if (!controller.signal.aborted && sequence.current === version) setPreview({ key, result: data });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted && sequence.current === version) setPreviewError(errorText(error));
      });
    }, 350);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [key, issue, retry]);

  async function save() {
    if (savingRef.current || issue || !name.trim() || !result?.tracks.length || !result.refreshedAt) return;
    savingRef.current = true; setSaving(true); setSaveError(""); setSaved("");
    try {
      const request = JSON.parse(key);
      const payload = { name: name.trim(), ...request };
      const response: { playlist: SmartPlaylist | SavedMix } = updating
        ? await (recordId ? updateSmartPlaylist(recordId, payload) : createSmartPlaylist(payload))
        : await saveMixPlaylist({ ...payload, ...(result.selectionToken ? { selectionToken: result.selectionToken } : {}) });
      window.dispatchEvent(new Event(updating ? "smartPlaylistsChanged" : "playlistsChanged"));
      if (!mounted.current) return;
      if (updating) setRecordId(response.playlist.id);
      setSaved(updating ? "Saved. Your mix will follow your library and listening history." : "Playlist saved with these songs.");
      onSaved?.(response.playlist as SmartPlaylist, updating ? "smart" : "playlist");
    } catch (error) { if (mounted.current) setSaveError(errorText(error)); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  }

  const update = (values: Partial<typeof recipe>) => { setRecipe((current) => ({ ...current, ...values })); setSaved(""); };
  return <section className="mix-maker" aria-label="Mix maker">
    <p className="mix-intro">Choose how to build your mix from your library.</p>
    <div className="mix-starts" role="group" aria-label="Choose a mix">
      {starts.map((start) => <button key={start.id} type="button" disabled={saving} aria-pressed={recipe.mode === start.id}
        onClick={() => { if (recipe.mode !== start.id) setRecipe(newMixRecipe(start.id)); setSaved(""); }}>
        <span className="mix-start-symbol" aria-hidden="true">{start.symbol}</span>
        <strong>{start.title}</strong><small>{start.description}</small>
      </button>)}
    </div>
    {recipe.mode && <div className="mix-workspace">
      <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="mix-form">
        <fieldset disabled={saving}>
          <legend className="sr-only">Your mix</legend>
          {recipe.mode === "similar" && <div className="mix-main-choice"><h3>Which song sets the tone?</h3>
            <SmartPlaylistSongPicker value={recipe.songId} onChange={(songId) => update({ songId })} path="mix" disabled={saving} />
            <p className="mix-help">Uses artist, genre and tagged tempo to suggest related library songs. Results depend on your music's tags.</p>
          </div>}
          {recipe.mode === "era" && <div className="mix-main-choice"><h3>Which era are we going back to?</h3>
            <div className="mix-decades" role="group" aria-label="Choose a decade">{[1960, 1970, 1980, 1990, 2000, 2010, 2020].map((year) => <button key={year} type="button"
              aria-pressed={recipe.from === String(year) && recipe.to === String(Math.min(year + 9, new Date().getFullYear()))}
              onClick={() => update({ from: String(year), to: String(Math.min(year + 9, new Date().getFullYear())) })}>{year}s</button>)}</div>
            <YearRange from={recipe.from} to={recipe.to} onChange={update} />
            <p className="mix-help">Uses original release years when supplied by your library, otherwise its year tags. A genre filter can help shape the occasion.</p>
          </div>}
          {recipe.mode === "rediscover" && <div className="mix-main-choice"><h3>Give an old favourite another turn.</h3>
            <label className="mix-label">Haven't listened in<select value={recipe.days} onChange={(event) => update({ days: event.target.value })}>
              <option value="30">The last 30 days</option><option value="90">The last 3 months</option><option value="180">The last 6 months</option><option value="365">The last year</option>
              {!["30", "90", "180", "365"].includes(recipe.days) && <option value={recipe.days}>The last {recipe.days} days</option>}
            </select></label><p className="mix-help">Songs you've played before, with the longest-unheard songs first. Likes and history belong to your account.</p>
          </div>}
          <details className="mix-refine"><summary>Refine your mix <span>Optional</span></summary>
            <div className="mix-refine-fields">
              <label className="mix-label">Genre<input value={recipe.genre} onChange={(event) => update({ genre: event.target.value })} maxLength={300} placeholder="e.g. Pop, rock or disco" /></label>
              <label className="mix-label">Artist<input value={recipe.artist} onChange={(event) => update({ artist: event.target.value })} maxLength={300} placeholder="Any artist" /></label>
              {recipe.mode !== "era" && <YearRange from={recipe.from} to={recipe.to} onChange={update} optional />}
              <label className="mix-check"><input type="checkbox" checked={recipe.likedOnly} onChange={(event) => update({ likedOnly: event.target.checked })} />Liked songs only</label>
            </div>
          </details>
          <div className="mix-save-fields">
            <label className="mix-label" htmlFor={`${id}-name`}>Playlist name<input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required placeholder="Give your mix a name" /></label>
            <label className="mix-label">Playlist size<select value={size} onChange={(event) => setSize(Number(event.target.value))}>
              {[25, 50, 100, 200, ...(playlist?.options?.size && ![25, 50, 100, 200].includes(playlist.options.size) ? [playlist.options.size] : [])].map((count) => <option key={count} value={count}>Up to {count} songs</option>)}
            </select></label>
          </div>
          <label className="mix-check mix-updating"><input type="checkbox" checked={updating} onChange={(event) => setUpdating(event.target.checked)} />
            <span><strong>Keep this mix updated</strong><small>{updating ? "Save as a smart playlist. Matching songs can change as your library and listening change." : "Save these songs as a regular playlist. The tracklist stays as you saved it."}</small></span>
          </label>
          {issue && <p className="mix-help" role="status">{issue}</p>}
          {saveError && <p role="alert" className="mix-feedback">{saveError}</p>}
          {saved && <p role="status" className="mix-feedback">{saved}</p>}
          <button type="submit" className="mix-save" disabled={saving || Boolean(issue) || !name.trim() || !result?.tracks.length || !result.refreshedAt}>
            {saving ? "Saving…" : updating ? recordId ? "Save changes" : "Save smart playlist" : recordId ? "Save as a fixed playlist" : "Save playlist"}
          </button>
        </fieldset>
      </form>
      <aside className="mix-preview" aria-label="Your mix preview" aria-busy={!issue && !result && !previewError}>
        <span className="mix-preview-eyebrow">YOUR MIX</span>
        <h3>{result ? `${result.total} ${result.total === 1 ? "song" : "songs"}` : "Your mix"}</h3>
        <p className="mix-help">{issue ? "Choose your starting point to see the songs." : previewError ? "Couldn't load your mix." : !result ? "Finding songs in your library…"
          : result.total < size ? `Found ${result.total} matching songs for your ${size}-song mix.` : `Selected from ${result.available ?? result.total} matching songs.`}</p>
        {previewError && <div role="alert">{previewError}<button type="button" onClick={() => setRetry((value) => value + 1)}>Retry preview</button></div>}
        {result?.warning && <p className="mix-help" role="status">{result.warning}</p>}
        {result?.tracks.length ? <ol>{result.tracks.map((track, index) => <li key={track.id}><span aria-hidden="true">{index + 1}</span><div><strong>{track.title}</strong><small>{track.artist}</small></div></li>)}</ol>
          : result && <p role="status" className="mix-help">No songs fit yet. Try another song, widen the era, or loosen a filter.</p>}
        {result && <><p className="mix-help">Showing the first {result.tracks.length} songs. {updating ? "Rechecked when you open or play the mix." : "The same selection will be saved."}</p>
          <button type="button" disabled={saving} onClick={() => setSeed(randomSeed())}>Try another mix</button></>}
      </aside>
    </div>}
  </section>;
}

function YearRange({ from, to, onChange, optional = false }: { from: string; to: string; onChange(value: { from?: string; to?: string }): void; optional?: boolean }) {
  return <div className="mix-years"><label className="mix-label">From year{optional && " (optional)"}<input type="number" min={1900} max={new Date().getFullYear() + 1} value={from} placeholder="1980" onChange={(event) => onChange({ from: event.target.value })} /></label>
    <label className="mix-label">To year{optional && " (optional)"}<input type="number" min={1900} max={new Date().getFullYear() + 1} value={to} placeholder="1989" onChange={(event) => onChange({ to: event.target.value })} /></label></div>;
}
