import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getArtist } from "../api/musicdeck";

export interface AlbumEdition {
  id: string | number;
  name?: string;
  artist?: string;
  artistId?: string | number | null;
  year?: string | number | null;
  songCount?: number;
  source?: { kind?: string };
  provider?: string;
}

const EDITION = /\b(?:deluxe|remaster(?:ed)?|expanded|anniversary|special edition|collector'?s edition|bonus (?:track|disc)|original (?:release|edition))\b/i;

export function albumReleaseName(name = ""): string {
  return name.normalize("NFKC")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, (part) => EDITION.test(part) ? "" : part)
    .replace(/\s+[-\u2013\u2014:]\s+(.+)$/, (part, suffix: string) => EDITION.test(suffix) ? "" : part)
    .replace(/\s+(?:\d{4}\s+)?(?:deluxe|expanded|remaster(?:ed)?|anniversary)(?:\s+(?:edition|version))?$/i, "")
    .trim().toLowerCase().replace(/\s+/g, " ");
}

export function matchingAlbumEditions(current: AlbumEdition, candidates: readonly AlbumEdition[]): AlbumEdition[] {
  const name = albumReleaseName(current.name);
  if (!name) return [];
  const byId = new Map<string, AlbumEdition>();
  for (const album of [current, ...candidates]) {
    if (album.provider === "external" || album.source?.kind === "external") continue;
    const sameArtist = current.artistId != null && album.artistId != null
      ? String(current.artistId) === String(album.artistId)
      : Boolean(current.artist && album.artist && current.artist.normalize("NFKC").trim().toLowerCase() === album.artist.normalize("NFKC").trim().toLowerCase());
    if ((String(album.id) === String(current.id) || sameArtist) && albumReleaseName(album.name) === name) {
      if (!byId.has(String(album.id))) byId.set(String(album.id), album);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const original = (album: AlbumEdition) => editionLabel(album) === "Original" ? 0 : 1;
    return original(a) - original(b) || String(a.year || "").localeCompare(String(b.year || "")) || String(a.id).localeCompare(String(b.id));
  });
}

function editionLabel(album: AlbumEdition): string {
  const name = album.name || "";
  const labels = [
    /deluxe/i.test(name) ? "Deluxe" : "",
    /remaster/i.test(name) ? "Remaster" : "",
    /expanded/i.test(name) ? "Expanded" : "",
    /anniversary/i.test(name) ? "Anniversary" : "",
  ].filter(Boolean);
  return labels.length ? labels.join(" / ") : /original (?:release|edition)/i.test(name) ? "Original"
    : EDITION.test(name) ? "Special edition" : "Original";
}

export default function AlbumEditionPicker({ album }: { album: AlbumEdition }) {
  const [result, setResult] = useState<{ key: string; albums: AlbumEdition[]; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([album.id, album.artistId, album.name, album.artist]);
  const eligible = album.artistId != null && !/^(external_|extdetail_)/.test(String(album.artistId)) &&
    album.provider !== "external" && album.source?.kind !== "external";
  useEffect(() => {
    if (!eligible) return undefined;
    let cancelled = false;
    getArtist(album.artistId).then((artist) => {
      if (!cancelled) setResult({ key, albums: matchingAlbumEditions(album, artist.album || []), error: null });
    }).catch((error: unknown) => {
      console.error("Could not load local album editions:", error);
      if (!cancelled) setResult({ key, albums: [], error: "Could not check local editions." });
    });
    return () => { cancelled = true; };
    // Album identity fields in key invalidate the request without depending on object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, eligible, attempt]);

  if (!eligible) return null;
  if (result?.key !== key) return <p className="album-editions-note" role="status">Checking local editions...</p>;
  if (result.error) return <div className="album-editions-note" role="status">
    {result.error} <button type="button" onClick={() => { setResult(null); setAttempt((value) => value + 1); }}>Retry</button>
  </div>;
  if (result.albums.length < 2) return null;
  return <nav className="album-editions" aria-label="Album editions">
    <span className="album-editions-label">Local editions</span>
    <div className="album-editions-options">
      {result.albums.map((edition) => <Link key={edition.id} to={`/album/${encodeURIComponent(edition.id)}`}
        aria-current={String(edition.id) === String(album.id) ? "page" : undefined}
        title={edition.name}>
        <strong>{editionLabel(edition)}</strong>
        <span>{[edition.year, typeof edition.songCount === "number" ? `${edition.songCount} tracks` : null].filter(Boolean).join(" / ") || edition.name}</span>
      </Link>)}
    </div>
  </nav>;
}
