import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { usePlayer } from "../../context/PlayerContext";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  DEFAULT_LAYOUT_PRESET,
  MOBILE_LAYOUT_QUERY,
  MOBILE_LAYOUT_SHELL,
  getLayoutPresetConfig,
} from "../../utils/layoutPreset";

import Topbar from "../Topbar";
import Sidebar from "../Sidebar";
import Player from "../Player";
import QueueSidebar from "../QueueSidebar";
import NowPlayingSidebar from "../NowPlayingSidebar";
import AppleHeaderPlayer from "./HeaderPlayers/AppleHeaderPlayer";
import TopNavHeader, { NAV_DRAWER_ID } from "./Headers/TopNavHeader";
import DrawerPlayerBar from "./PlayerBars/DrawerPlayerBar";
import WidgetSidebar from "./WidgetSidebar";
import MobileNavBar from "./MobileNavBar";


function getContentClassName(pathname) {
  const isDetailPage = pathname === "/liked" || /^\/(?:album|artist|playlist)\/[^/]+/.test(pathname);
  const isSongPage = isDetailPage || ["/library/tracks", "/liked", "/search"].includes(pathname);
  const isWideContentPage = isSongPage || ["/", "/explore", "/listening-activity"].includes(pathname) ||
    /^\/library\/(?:playlists|albums|artists)$/.test(pathname);
  return [
    "main-content",
    isDetailPage && "main-content--detail",
    pathname === "/" && "main-content--home",
    isWideContentPage && "main-content--wide",
    (pathname === "/explore" || pathname === "/search") && "main-content--full-bleed-hero",
  ].filter(Boolean).join(" ");
}


/**
 * Layout shell engine. Composes header, navigation, player and side panels
 * for the selected preset archetype, or the unified mobile shell below
 * 768px. Every slot is keyed so switching presets swaps only the shell
 * chrome: <main>, the routed page and the library sidebar keep their
 * identity, and all audio/queue state lives in PlayerProvider above this.
 */
function AppLayout({ preset = DEFAULT_LAYOUT_PRESET, children }) {
  const location = useLocation();
  const {
    currentSong,
    activeSidebar,
    setActiveSidebar,
    autoOpenSidebar,
  } = usePlayer();
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const shell = isMobile ? MOBILE_LAYOUT_SHELL : getLayoutPresetConfig(preset).value;
  const config = getLayoutPresetConfig(preset).shell;
  const usesDrawerNav = shell === "ytmusic" || shell === MOBILE_LAYOUT_SHELL;
  const [isNavDrawerOpen, setIsNavDrawerOpen] = useState(false);
  const previousTrackIdRef = useRef(null);
  const isPanelOpen = activeSidebar !== "none";

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.layoutShell = shell;
    return () => {
      delete root.dataset.layoutShell;
    };
  }, [shell]);

  useEffect(() => {
    const root = document.documentElement;
    if (usesDrawerNav && isNavDrawerOpen) root.dataset.navDrawer = "open";
    else delete root.dataset.navDrawer;
    return () => {
      delete root.dataset.navDrawer;
    };
  }, [usesDrawerNav, isNavDrawerOpen]);

  useEffect(() => {
    setIsNavDrawerOpen(false);
  }, [location.pathname, shell]);

  useEffect(() => {
    if (!isNavDrawerOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setIsNavDrawerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isNavDrawerOpen]);

  // Auto-open Now Playing on a new track only where the panel docks beside
  // the page; in sheet/widget/mobile shells it would cover the content.
  const canAutoOpenPanel = shell === "spotify" || shell === "apple";
  useEffect(() => {
    const nextTrackId = currentSong?.id == null ? null : String(currentSong.id);
    const isNewTrack = Boolean(nextTrackId) && nextTrackId !== previousTrackIdRef.current;
    if (isNewTrack && autoOpenSidebar && canAutoOpenPanel && activeSidebar !== "now-playing") {
      setActiveSidebar("now-playing");
    }
    previousTrackIdRef.current = nextTrackId;
  }, [currentSong?.id, autoOpenSidebar, canAutoOpenPanel, activeSidebar, setActiveSidebar]);

  const toggleNavDrawer = useCallback(() => setIsNavDrawerOpen((open) => !open), []);
  const toggleQueue = useCallback(
    () => setActiveSidebar((current) => current === "queue" ? "none" : "queue"),
    [setActiveSidebar],
  );
  const drawer = usesDrawerNav ? { isOpen: isNavDrawerOpen, onToggle: toggleNavDrawer } : null;

  let header;
  if (shell === MOBILE_LAYOUT_SHELL) header = <TopNavHeader key="header-topnav" drawer={drawer} />;
  else if (config.header === "player") header = <Topbar key="header-player" playerSlot={<AppleHeaderPlayer />} />;
  else if (config.header === "topnav") header = <TopNavHeader key="header-topnav" drawer={drawer} />;
  else header = <Topbar key="header-standard" />;

  let player = null;
  if (shell === MOBILE_LAYOUT_SHELL || config.player === "bar") {
    player = <Player key="player-bar" isQueueSidebarOpen={activeSidebar === "queue"} onToggleQueueSidebar={toggleQueue} />;
  } else if (config.player === "drawer") {
    player = <DrawerPlayerBar key="player-drawer" />;
  }

  const showWidgets = shell !== MOBILE_LAYOUT_SHELL && config.aside === "widgets";
  const showPanelToggle = shell === "spotify" && activeSidebar === "none";

  return (
    <>
      {header}
      {usesDrawerNav && isNavDrawerOpen && (
        <div key="nav-scrim" className="nav-drawer-scrim" aria-hidden="true" onClick={() => setIsNavDrawerOpen(false)} />
      )}
      <Sidebar key="sidebar" id={NAV_DRAWER_ID} />
      <main key="main" className={`main${isPanelOpen ? " sidebar-open" : ""}`}>
        {showPanelToggle && (
          <button
            className="main-now-playing-toggle"
            type="button"
            onClick={() => setActiveSidebar("now-playing")}
            aria-label="Open Now Playing sidebar"
          >
            <span aria-hidden="true">♫</span>
            Now Playing
          </button>
        )}
        <div className={`main-shell${showWidgets ? " main-shell--widgets" : ""}`}>
          <div className={getContentClassName(location.pathname)}>
            {children}
          </div>
          {showWidgets && <WidgetSidebar />}
        </div>
      </main>
      <QueueSidebar
        key="queue-panel"
        isOpen={activeSidebar === "queue"}
        onClose={() => setActiveSidebar("none")}
      />
      <NowPlayingSidebar
        key="now-playing-panel"
        isOpen={activeSidebar === "now-playing"}
        onClose={() => setActiveSidebar("none")}
        onOpenQueue={() => setActiveSidebar("queue")}
      />
      {player}
      {shell === MOBILE_LAYOUT_SHELL && <MobileNavBar key="mobile-nav" />}
    </>
  );
}

export default AppLayout;
