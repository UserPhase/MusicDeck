import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import { usePlayer } from "../context/PlayerContext";
import { getCoverUrl, getListeningHistory, getListeningStatistics, getListeningTrack,
  LISTENING_ACTIVITY_CHANGED_EVENT } from "../api/musicdeck";
import TrackRow from "../components/TrackRow";
import useTrackPlaylistMenu from "../hooks/useTrackPlaylistMenu";
import { toArtistRouteIdFromApiId } from "../utils/idResolver";
import { LoadingState, EmptyState, ErrorState } from "../components/ui/PageState";
import "../styles/listening-activity.css";

const PERIODS = [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"],
  ["year", "This year"], ["all", "All time"]];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function listeningTime(seconds) {
  const minutes = Math.floor((Number(seconds) || 0) / 60);
  if (minutes < 1) return `${Math.round(seconds || 0)} sec`;
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export function historyDate(value, now = new Date()) {
  const date = new Date(value);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function Artwork({ track }) {
  const url = track?.coverUrl || getCoverUrl(track?.coverArt, 80);
  return url ? <img src={url} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> :
    <span aria-hidden="true" className="activity-artwork-placeholder">&#9835;</span>;
}

function Ranking({ title, items, kind, onPlay }) {
  return <section className="activity-ranking" aria-label={title}>
    <h2>{title}</h2>
    {!items.length ? <p className="activity-muted">No recorded {kind} yet.</p> :
      <ol>{items.map((item, index) => {
        const track = item.track;
        const name = kind === "artists" ? track?.artist : kind === "albums" ? track?.album : track?.title;
        const id = kind === "artists" ? track?.artistId : track?.albumId;
        return <li key={item.key}>
          <span className="activity-rank">{index + 1}</span>
          <span className="activity-artwork"><Artwork track={track} /></span>
          <div className="activity-rank-copy">
            {kind === "songs" ? <button type="button" onClick={() => onPlay({ id: item.key })}>{name || "Unavailable track"}</button> :
              id ? <Link to={`/${kind === "artists" ? "artist" : "album"}/${encodeURIComponent(kind === "artists" ? toArtistRouteIdFromApiId(id) : id)}`}>{name || item.key}</Link> :
                <strong>{name || "Unknown"}</strong>}
            <small>{kind === "songs" ? track?.artist || "Unknown artist" : listeningTime(item.listeningSeconds)}</small>
          </div>
          <span className="activity-rank-plays">{item.plays} <small>{item.plays === 1 ? "play" : "plays"}</small></span>
        </li>;
      })}</ol>}
  </section>;
}

function Bars({ items, label, formatLabel = (bucket) => bucket }) {
  const max = Math.max(1, ...items.map((item) => item.listeningSeconds));
  return <div className="activity-chart" role="list" aria-label={label}>
    {items.map((item) => <div className="activity-chart-column" role="listitem" key={item.bucket}
      aria-label={`${formatLabel(item.bucket)}: ${listeningTime(item.listeningSeconds)}, ${item.plays} plays`}>
      <div className="activity-chart-bar-space">
        <span className="activity-chart-bar" style={{ height: `${item.listeningSeconds / max * 100}%` }}
          title={`${formatLabel(item.bucket)}: ${listeningTime(item.listeningSeconds)} (${item.plays} plays)`} />
      </div>
      <small>{formatLabel(item.bucket)}</small>
    </div>)}
  </div>;
}

function Statistics({ data, onPlay }) {
  const overview = data.overview;
  const monthly = data.period === "all" || data.period === "year";
  const trend = monthly ? data.monthly : data.daily;
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    const bucket = String(hour).padStart(2, "0");
    return data.hourly.find((item) => item.bucket === bucket) || { bucket, listeningSeconds: 0, plays: 0 };
  });
  const activeDays = [...data.weekdays].sort((a, b) => b.listeningSeconds - a.listeningSeconds);
  return <>
    <dl className="activity-overview">
      {[["Listening time", listeningTime(overview.listeningSeconds)], ["Song plays", overview.plays || 0],
        ["Unique songs", overview.uniqueSongs], ["Artists", overview.uniqueArtists], ["Albums", overview.uniqueAlbums]]
        .map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value.toLocaleString()}</dd></div>)}
    </dl>
    <p className="activity-muted">Listening time measures actual playback, including short listens. Song plays count only qualified listens.
      {overview.legacyPlays > 0 && ` ${overview.legacyPlays} older plays have no duration or complete metadata; those values aren't estimated.`}
    </p>
    {!overview.plays && !overview.listeningSeconds ? <EmptyState>No listening data for this period. Play some music to start your story.</EmptyState> : <>
      <div className="activity-top-music">
        <Ranking title="Top songs" items={data.topSongs} kind="songs" onPlay={onPlay} />
        <Ranking title="Top artists" items={data.topArtists} kind="artists" onPlay={onPlay} />
        <Ranking title="Top albums" items={data.topAlbums} kind="albums" onPlay={onPlay} />
      </div>
      <section className="activity-trends">
        <header><h2>Your listening rhythm</h2><span className="activity-muted">By playback start, in UTC</span></header>
        <h3>Listening time by {monthly ? "month" : "day"}</h3>
        {trend.length ? <Bars items={trend} label="Listening activity over time"
          formatLabel={(value) => monthly ? value : value.slice(5)} /> : <p className="activity-muted">No measured listening time yet.</p>}
        <div className="activity-trends-bottom">
          <section><h3>By hour of day</h3><Bars items={hourly} label="Listening time by hour" /></section>
          <section><h3>Most active days</h3><ol className="activity-active-days">
            {activeDays.map((day) => <li key={day.bucket}><span>{WEEKDAYS[Number(day.bucket)]}</span>
              <strong>{listeningTime(day.listeningSeconds)}</strong><small>{day.plays} plays</small></li>)}
          </ol></section>
        </div>
      </section>
    </>}
  </>;
}

export default function ListeningActivity() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "statistics" ? "statistics" : "history";
  const [period, setPeriod] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const { session } = useAuth();
  const { playSong } = usePlayer();
  const client = useQueryClient();
  const menus = useTrackPlaylistMenu(setNotice);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const invalidate = () => client.invalidateQueries({ queryKey: ["listening-activity", session?.id] });
    window.addEventListener(LISTENING_ACTIVITY_CHANGED_EVENT, invalidate);
    return () => window.removeEventListener(LISTENING_ACTIVITY_CHANGED_EVENT, invalidate);
  }, [client, session?.id]);

  const history = useInfiniteQuery({
    queryKey: ["listening-activity", session?.id, "history", period, query],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => getListeningHistory({ period, search: query, cursor: pageParam, signal }),
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: Boolean(session?.id) && tab === "history", staleTime: 30_000,
  });
  const statistics = useQuery({
    queryKey: ["listening-activity", session?.id, "statistics", period],
    queryFn: ({ signal }) => getListeningStatistics(period, signal),
    enabled: Boolean(session?.id) && tab === "statistics", staleTime: 30_000,
  });
  const groups = useMemo(() => {
    const result = new Map();
    for (const item of history.data?.pages.flatMap((page) => page.items) || []) {
      const date = historyDate(item.playedAt);
      if (!result.has(date)) result.set(date, []);
      result.get(date).push(item);
    }
    return [...result];
  }, [history.data]);

  async function play(track) {
    setNotice("");
    try {
      const current = await getListeningTrack(track.id);
      if (!current || current.availability?.libraryAvailable === false) throw new Error("This track is no longer available in your library.");
      await playSong(current);
    } catch (error) {
      setNotice(error.message || "This track is currently unavailable.");
    }
  }
  const currentQuery = tab === "history" ? history : statistics;
  return <div className="activity-page">
    <header className="activity-heading"><span className="activity-eyebrow">YOUR MUSIC, THROUGH TIME</span>
      <h1>Listening Activity</h1><p>Your listening story. Every return, every discovery.</p></header>
    <div className="activity-toolbar">
      <div className="activity-tabs" role="tablist" aria-label="Listening activity">
        {["history", "statistics"].map((value) => <button key={value} type="button" role="tab"
          id={`activity-${value}-tab`} aria-selected={tab === value} aria-controls="activity-panel"
          tabIndex={tab === value ? 0 : -1}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "history" : event.key === "End" ? "statistics" : tab === "history" ? "statistics" : "history";
            setParams({ tab: next });
            event.currentTarget.parentElement.querySelector(`#activity-${next}-tab`).focus();
          }}
          className={tab === value ? "active" : ""} onClick={() => setParams({ tab: value })}>
          {value === "history" ? "History" : "Statistics"}
        </button>)}
      </div>
      {tab === "history" && <label className="activity-search"><span className="sr-only">Search listening history</span>
        <input type="search" placeholder="Find a song, artist, or album" value={search}
          onChange={(event) => setSearch(event.target.value)} /></label>}
      <label className="activity-period"><span className="sr-only">Time period</span>
        <select aria-label="Time period" value={period} onChange={(event) => setPeriod(event.target.value)}>
          {PERIODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
    </div>
    {notice && <p className="activity-notice" role="status">{notice}</p>}
    <div id="activity-panel" role="tabpanel" aria-labelledby={`activity-${tab}-tab`}>
      {currentQuery.isPending ? <LoadingState>Loading your listening activity...</LoadingState> :
        currentQuery.isError ? <ErrorState>{currentQuery.error.message} <button type="button" onClick={() => currentQuery.refetch()}>Try again</button></ErrorState> :
          tab === "statistics" ? statistics.data && <Statistics data={statistics.data} onPlay={play} /> : <>
            {!groups.length ? <EmptyState>{query ? "No listens match your search." : "No listening history for this period. Your next listen starts here."}</EmptyState> :
              groups.map(([date, events]) => <section className="activity-date-group" key={date}>
                <h2>{date}<span>{events.length} listens shown</span></h2>
                <div className="track-list track-list--compact" role="table" aria-label={`${date} listening history`}>
                  {events.map((event, index) => <div className="activity-history-row" key={event.id}>
                    <TrackRow song={event.track} index={index} onPlay={play} showArtwork showAlbum={false} preserveDeleted
                      onToggleMenu={(song, e) => menus.toggleMenu(song, e, event.id)}
                      menu={menus.isOpen(event.track, event.id) ? menus.renderMenu(event.track) : null} />
                    <time dateTime={event.playedAt}>{new Date(event.playedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
                  </div>)}
                </div>
              </section>)}
            {history.hasNextPage && <button className="activity-load-more" type="button" disabled={history.isFetchingNextPage}
              onClick={() => history.fetchNextPage()}>{history.isFetchingNextPage ? "Loading..." : "Load more history"}</button>}
          </>}
    </div>
  </div>;
}
