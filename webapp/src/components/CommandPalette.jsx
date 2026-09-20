import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { searchNavidrome } from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";

const QUICK_ACTIONS = [
  { id: "library", label: "Go to Library", detail: "Your saved music", shortcut: "G L", path: "/library/tracks" },
  { id: "explore", label: "Go to Explore", detail: "Discover something new", shortcut: "G E", path: "/explore" },
  { id: "settings", label: "Go to Settings", detail: "Tune MusicDeck", shortcut: "G S", path: "/settings" },
  { id: "queue", label: "Open Queue", detail: "See what plays next", shortcut: "Q", sidebar: "queue" },
  { id: "theme", label: "Toggle Dark / Light Theme", detail: "Change the workspace surface", shortcut: "T", theme: true },
];

function matchesQuery(item, query) {
  const text = `${item.label || item.title || ""} ${item.detail || item.artist || ""}`.toLowerCase();
  return text.includes(query.toLowerCase());
}

function CommandPalette({ isOpen, onClose, onToggleTheme }) {
  const navigate = useNavigate();
  const { playSong, setActiveSidebar } = usePlayer();
  const inputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);

  const quickActions = useMemo(
    () => QUICK_ACTIONS.filter((action) => matchesQuery(action, query)),
    [query]
  );

  const items = useMemo(
    () => [...quickActions, ...searchResults],
    [quickActions, searchResults]
  );

  useEffect(() => {
    if (!isOpen) return undefined;
    setQuery("");
    setSearchResults([]);
    setActiveIndex(0);
    inputRef.current?.focus();
    return undefined;
  }, [isOpen]);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (!isOpen || trimmedQuery.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return undefined;
    }

    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      setIsSearching(true);
      try {
        const result = await searchNavidrome(trimmedQuery);
        if (cancelled) return;

        setSearchResults([
          ...(result.songs || []).slice(0, 5).map((song) => ({
            id: `song-${song.id}`,
            kind: "track",
            label: song.title || "Unknown track",
            detail: song.artist || "Unknown artist",
            song,
          })),
          ...(result.artists || []).slice(0, 3).map((artist) => ({
            id: `artist-${artist.id}`,
            kind: "artist",
            label: artist.name || "Unknown artist",
            detail: "Artist",
            path: `/artist/${artist.id}`,
          })),
          ...(result.playlists || []).slice(0, 3).map((playlist) => ({
            id: `playlist-${playlist.id}`,
            kind: "playlist",
            label: playlist.name || "Untitled playlist",
            detail: "Playlist",
            path: `/playlist/${playlist.id}`,
          })),
        ]);
      } catch (error) {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [isOpen, query]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(items.length - 1, 0)));
  }, [items.length]);

  function runItem(item) {
    if (!item) return;
    if (item.song) playSong(item.song);
    if (item.path) navigate(item.path);
    if (item.sidebar) setActiveSidebar(item.sidebar);
    if (item.theme) onToggleTheme?.();
    onClose();
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, items.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runItem(items[activeIndex]);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-palette-input-wrap">
          <span aria-hidden="true">⌕</span>
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder="Search music, artists, playlists, or commands…" aria-label="Command palette search" />
          <kbd>Esc</kbd>
        </div>
        <div className="command-palette-results" role="listbox" aria-label="Command palette results">
          {quickActions.length > 0 && <p className="command-palette-label">Quick actions</p>}
          {items.map((item, index) => (
            <button key={item.id} type="button" className={`command-palette-item${index === activeIndex ? " active" : ""}`} role="option" aria-selected={index === activeIndex} onMouseEnter={() => setActiveIndex(index)} onClick={() => runItem(item)}>
              <span className={`command-palette-kind ${item.kind || "command"}`} aria-hidden="true">{item.kind === "track" ? "♫" : item.kind === "artist" ? "◌" : item.kind === "playlist" ? "≡" : "›"}</span>
              <span className="command-palette-item-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          ))}
          {isSearching && <p className="command-palette-state">Searching your library…</p>}
          {!isSearching && query.trim().length >= 2 && searchResults.length === 0 && <p className="command-palette-state">No matching music found.</p>}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span></footer>
      </section>
    </div>
  );
}

export default CommandPalette;
