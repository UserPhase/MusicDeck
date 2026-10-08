import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { adminLogsStreamUrl, clearAdminLogs, getAdminLogs } from "../../api/musicdeck";

export const MAX_CLIENT_LOGS = 1000;

const LEVEL_FILTERS = [
  { id: "all", label: "All" },
  { id: "error", label: "Errors" },
  { id: "warn", label: "Warnings" },
  { id: "info", label: "Info" },
];

const STATUS_LABELS = {
  connecting: "Connecting",
  live: "Live",
  paused: "Paused",
  reconnecting: "Reconnecting",
  unsupported: "Live stream unavailable",
};

function pad(value, size = 2) {
  return String(value).padStart(size, "0");
}

export function formatLogTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--.---";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatMeta(meta) {
  try {
    return JSON.stringify(meta, null, 2);
  } catch {
    return String(meta);
  }
}

export function formatLogLine(entry) {
  const head = `${entry.timestamp} [${entry.level.toUpperCase()}] ${entry.message}`;
  const parts = [head];
  if (entry.stack && !entry.stack.startsWith(entry.message)) parts.push(entry.stack);
  else if (entry.stack) parts[0] = `${entry.timestamp} [${entry.level.toUpperCase()}] ${entry.stack}`;
  if (entry.meta) parts.push(formatMeta(entry.meta));
  return parts.join("\n");
}

function appendCapped(current, incoming) {
  if (!incoming.length) return current;
  const next = current.concat(incoming);
  return next.length > MAX_CLIENT_LOGS ? next.slice(next.length - MAX_CLIENT_LOGS) : next;
}

function matchesSearch(entry, needle) {
  if (!needle) return true;
  if (entry.message.toLowerCase().includes(needle)) return true;
  if (entry.stack && entry.stack.toLowerCase().includes(needle)) return true;
  return Boolean(entry.meta) && formatMeta(entry.meta).toLowerCase().includes(needle);
}

const LogRow = memo(function LogRow({ entry, expanded, onToggle }) {
  const expandable = Boolean(entry.stack || entry.meta);
  const content = (
    <>
      <time className="log-row__time" dateTime={entry.timestamp}>{formatLogTime(entry.timestamp)}</time>
      <span className={`log-row__badge log-row__badge--${entry.level}`}>{entry.level.toUpperCase()}</span>
      <span className="log-row__message">{entry.message}</span>
      {expandable ? <span className="log-row__chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span> : null}
    </>
  );

  return (
    <li className={`log-row log-row--${entry.level}${expanded ? " is-expanded" : ""}`}>
      {expandable ? (
        <button type="button" className="log-row__line" aria-expanded={expanded} onClick={() => onToggle(entry.seq)}>
          {content}
        </button>
      ) : (
        <div className="log-row__line">{content}</div>
      )}
      {expanded && expandable ? (
        <div className="log-row__details">
          {entry.stack ? <pre className="log-row__stack">{entry.stack}</pre> : null}
          {entry.meta ? <pre className="log-row__meta">{formatMeta(entry.meta)}</pre> : null}
          <span className="log-row__source">source: {entry.source} · seq {entry.seq}</span>
        </div>
      ) : null}
    </li>
  );
});

export default function AdminLogs() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("connecting");
  const [levelFilter, setLevelFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set());
  const [notice, setNotice] = useState("");
  const [stats, setStats] = useState(null);

  const lastSeqRef = useRef(0);
  const pausedRef = useRef(false);
  const viewportRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  pausedRef.current = paused;

  const flash = useCallback((message) => {
    setNotice(message);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(""), 2400);
  }, []);

  useEffect(() => () => window.clearTimeout(noticeTimerRef.current), []);

  const ingest = useCallback((incoming) => {
    const fresh = incoming.filter((entry) => entry.seq > lastSeqRef.current);
    if (!fresh.length) return;
    lastSeqRef.current = fresh[fresh.length - 1].seq;
    if (pausedRef.current) setHeld((current) => appendCapped(current, fresh));
    else setEntries((current) => appendCapped(current, fresh));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let source = null;

    async function start() {
      try {
        const data = await getAdminLogs({ limit: MAX_CLIENT_LOGS });
        if (cancelled) return;
        const initial = data?.entries || [];
        setEntries(initial);
        setStats(data?.stats || null);
        lastSeqRef.current = initial.length ? initial[initial.length - 1].seq : (data?.stats?.lastSeq || 0);
      } catch (error) {
        if (cancelled) return;
        setLoadError(error.message || "Could not load server logs.");
      } finally {
        if (!cancelled) setLoading(false);
      }

      if (cancelled) return;
      if (typeof window.EventSource !== "function") {
        setStatus("unsupported");
        return;
      }

      // EventSource resends the last frame id on reconnect, so the server
      // replays anything missed while the connection was down.
      source = new window.EventSource(adminLogsStreamUrl(lastSeqRef.current));
      source.addEventListener("open", () => setStatus(pausedRef.current ? "paused" : "live"));
      source.addEventListener("ready", (event) => {
        setStatus(pausedRef.current ? "paused" : "live");
        try {
          setStats(JSON.parse(event.data).stats || null);
        } catch {
          // Stats are informational only.
        }
      });
      source.addEventListener("logs", (event) => {
        try {
          ingest(JSON.parse(event.data).entries || []);
        } catch {
          // Ignore a malformed frame rather than tearing down the stream.
        }
      });
      source.addEventListener("cleared", () => {
        setEntries([]);
        setHeld([]);
        setExpanded(new Set());
      });
      source.addEventListener("error", () => {
        if (!cancelled) setStatus("reconnecting");
      });
    }

    start();
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [ingest]);

  const visible = useMemo(
    () => entries.filter((entry) => (levelFilter === "all" || entry.level === levelFilter) && matchesSearch(entry, deferredSearch)),
    [entries, levelFilter, deferredSearch],
  );

  const counts = useMemo(() => {
    const result = { error: 0, warn: 0, info: 0, debug: 0 };
    for (const entry of entries) result[entry.level] = (result[entry.level] || 0) + 1;
    return result;
  }, [entries]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (autoScroll && viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [visible, autoScroll]);

  function handleScroll(event) {
    const viewport = event.currentTarget;
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 32;
    if (!atBottom && autoScroll) setAutoScroll(false);
    else if (atBottom && !autoScroll) setAutoScroll(true);
  }

  function togglePaused() {
    if (paused) {
      setEntries((current) => appendCapped(current, held));
      setHeld([]);
      setPaused(false);
      setStatus((current) => (current === "paused" ? "live" : current));
    } else {
      setPaused(true);
      setStatus((current) => (current === "live" ? "paused" : current));
    }
  }

  const toggleExpanded = useCallback((seq) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  async function handleCopy() {
    const text = visible.map(formatLogLine).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      flash(`Copied ${visible.length} ${visible.length === 1 ? "entry" : "entries"}`);
    } catch {
      flash("Clipboard access was blocked by the browser");
    }
  }

  function handleExport() {
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const blob = new Blob([`${visible.map(formatLogLine).join("\n")}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `musicdeck-server-${stamp}.log`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    flash(`Exported ${visible.length} ${visible.length === 1 ? "entry" : "entries"}`);
  }

  async function handleClear() {
    if (!window.confirm("Clear the server log buffer for every admin? This does not affect Docker or terminal output.")) return;
    try {
      await clearAdminLogs();
      setEntries([]);
      setHeld([]);
      setExpanded(new Set());
      flash("Log buffer cleared");
    } catch (error) {
      flash(error.message || "Could not clear the log buffer");
    }
  }

  const statusKey = paused && status === "live" ? "paused" : status;

  return (
    <section className="admin-section admin-logs">
      <header className="admin-logs__header">
        <div>
          <h2>Logs</h2>
          <p className="account-meta">
            The most recent {stats?.capacity || MAX_CLIENT_LOGS} server log lines, streamed live. Secrets and session tokens are redacted.
          </p>
        </div>
        <span className={`log-status log-status--${statusKey}`} role="status">
          <span className="log-status__dot" aria-hidden="true" />
          {STATUS_LABELS[statusKey] || statusKey}
        </span>
      </header>

      <div className="log-console">
        <div className="log-toolbar">
          <div className="log-filter" role="group" aria-label="Filter by level">
            {LEVEL_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className={`log-filter__option log-filter__option--${filter.id}`}
                aria-pressed={levelFilter === filter.id}
                onClick={() => setLevelFilter(filter.id)}
              >
                {filter.label}
                <span className="log-filter__count">
                  {filter.id === "all" ? entries.length : counts[filter.id] || 0}
                </span>
              </button>
            ))}
          </div>

          <label className="log-search">
            <span className="log-search__prompt" aria-hidden="true">/</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search messages, routes, error codes…"
              aria-label="Search logs"
              spellCheck={false}
            />
          </label>

          <div className="log-actions">
            <button type="button" className="log-tool" aria-pressed={!paused} onClick={togglePaused}>
              {paused ? `Resume${held.length ? ` · ${held.length} new` : ""}` : "Pause"}
            </button>
            <button type="button" className="log-tool" aria-pressed={autoScroll} onClick={() => setAutoScroll((value) => !value)}>
              Auto-scroll
            </button>
            <button type="button" className="log-tool" onClick={handleCopy} disabled={!visible.length}>Copy</button>
            <button type="button" className="log-tool" onClick={handleExport} disabled={!visible.length}>Export .log</button>
            <button type="button" className="log-tool log-tool--danger" onClick={handleClear}>Clear buffer</button>
          </div>
        </div>

        <div className="log-viewport" ref={viewportRef} onScroll={handleScroll} tabIndex={0} aria-label="Server log output">
          {loading ? <p className="log-empty">Loading server logs…</p> : null}
          {!loading && loadError ? <p className="log-empty log-empty--error">{loadError}</p> : null}
          {!loading && !loadError && !visible.length ? (
            <p className="log-empty">
              {entries.length ? "No log lines match the current filter." : "No server log lines yet. New output will appear here as it happens."}
            </p>
          ) : null}
          {visible.length ? (
            <ol className="log-list">
              {visible.map((entry) => (
                <LogRow key={entry.seq} entry={entry} expanded={expanded.has(entry.seq)} onToggle={toggleExpanded} />
              ))}
            </ol>
          ) : null}
        </div>

        <footer className="log-footer">
          <span>Showing {visible.length} of {entries.length}</span>
          {!autoScroll && visible.length ? (
            <button type="button" className="log-footer__jump" onClick={() => setAutoScroll(true)}>Jump to latest ↓</button>
          ) : null}
          <span className="log-footer__notice" aria-live="polite">{notice}</span>
        </footer>
      </div>
    </section>
  );
}
