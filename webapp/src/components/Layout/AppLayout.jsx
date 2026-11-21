import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { usePlayer } from "../../context/PlayerContext";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useRouteScrollRestoration } from "../../hooks/useViewStateStore";
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
  const isWideContentPage = isDetailPage
    || ["/", "/search", "/explore", "/saved-discoveries", "/downloads", "/listening-activity", "/new-releases"].includes(pathname)
    || /^\/smart-playlist\/[^/]+/.test(pathname)
    || /^\/library(?:\/(?:tracks|playlists|smart-playlists|albums|artists|health))?\/?$/.test(pathname);
  return [
    "main-content",
    isDetailPage && "main-content--detail",
    pathname === "/" && "main-content--home",
    isWideContentPage && "main-content--wide",
    ["/explore", "/search", "/saved-discoveries"].includes(pathname) && "main-content--full-bleed-hero",
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
  const mainRef = useRef(null);
  const nowPlayingButtonRef = useRef(null);
  const nowPlayingCloseRef = useRef(null);
  const queueCloseRef = useRef(null);
  const previousPathnameRef = useRef(location.pathname);
  const restorePlayerFocusRef = useRef(false);
  useRouteScrollRestoration(mainRef);
  const {
    currentSong,
    activeSidebar,
    setActiveSidebar,
    autoOpenSidebar,
  } = usePlayer();
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const shell = isMobile ? MOBILE_LAYOUT_SHELL : getLayoutPresetConfig(preset).value;
  const config = getLayoutPresetConfig(preset).shell;
  const usesDrawerNav = shell === "ytmusic";
  const [isNavDrawerOpen, setIsNavDrawerOpen] = useState(false);
  const previousTrackIdRef = useRef(null);
  const isPanelOpen = activeSidebar !== "none";
  const mobilePanel = isMobile ? activeSidebar : "none";
  const mobileNowPlayingOpen = mobilePanel === "now-playing";
  const mobileQueueOpen = mobilePanel === "queue";
  const closePanel = useCallback(() => {
    restorePlayerFocusRef.current = isMobile;
    setActiveSidebar("none");
  }, [isMobile, setActiveSidebar]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.layoutShell = shell;
    return () => {
      delete root.dataset.layoutShell;
    };
  }, [shell]);

  useLayoutEffect(() => {
    if (mobilePanel === "now-playing") nowPlayingCloseRef.current?.focus();
    else if (mobilePanel === "queue") queueCloseRef.current?.focus();
    else if (restorePlayerFocusRef.current) {
      restorePlayerFocusRef.current = false;
      nowPlayingButtonRef.current?.focus();
    }
  }, [mobilePanel]);

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
    if (isMobile && previousPathnameRef.current !== location.pathname) setActiveSidebar("none");
    previousPathnameRef.current = location.pathname;
  }, [isMobile, location.pathname, setActiveSidebar]);

  useEffect(() => {
    if (!isNavDrawerOpen && mobilePanel === "none") return undefined;
    const closeOnEscape = (event) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (isNavDrawerOpen) setIsNavDrawerOpen(false);
      else closePanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closePanel, isNavDrawerOpen, mobilePanel]);

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
  if (shell === MOBILE_LAYOUT_SHELL) header = <Topbar key="header-mobile" mobile />;
  else if (config.header === "player") header = <Topbar key="header-player" playerSlot={<AppleHeaderPlayer />} />;
  else if (config.header === "topnav") header = <TopNavHeader key="header-topnav" drawer={drawer} />;
  else header = <Topbar key="header-standard" />;

  let player = null;
  if (shell === MOBILE_LAYOUT_SHELL) {
    player = <Player key="player-bar" mobile hidden={mobileNowPlayingOpen} nowPlayingButtonRef={nowPlayingButtonRef}
      onOpenNowPlaying={() => setActiveSidebar("now-playing")} />;
  } else if (config.player === "bar") {
    player = <Player key="player-bar" isQueueSidebarOpen={activeSidebar === "queue"} onToggleQueueSidebar={toggleQueue} />;
  } else if (config.player === "drawer") {
    player = <DrawerPlayerBar key="player-drawer" />;
  }

  const showWidgets = shell !== MOBILE_LAYOUT_SHELL && config.aside === "widgets";
  const showPanelToggle = shell === "spotify" && activeSidebar === "none";

  return (
    <>
      <div inert={mobileNowPlayingOpen || undefined}>
        {header}
        {usesDrawerNav && isNavDrawerOpen && (
          <div key="nav-scrim" className="nav-drawer-scrim" aria-hidden="true" onClick={() => setIsNavDrawerOpen(false)} />
        )}
        <Sidebar key="sidebar" id={NAV_DRAWER_ID} />
        <main ref={mainRef} key="main" className={`main${isPanelOpen ? " sidebar-open" : ""}`}
          inert={mobileQueueOpen || undefined}>
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
        {mobileQueueOpen && <div className="mobile-queue-scrim" aria-hidden="true" onClick={closePanel} />}
        <QueueSidebar
          key="queue-panel"
          isOpen={activeSidebar === "queue"}
          onClose={closePanel}
          closeButtonRef={queueCloseRef}
        />
        {player}
        {isMobile && <MobileNavBar key="mobile-nav" />}
      </div>
      <NowPlayingSidebar
        key="now-playing-panel"
        isOpen={activeSidebar === "now-playing"}
        onClose={closePanel}
        onOpenQueue={() => setActiveSidebar("queue")}
        mobile={isMobile}
        closeButtonRef={nowPlayingCloseRef}
      />
    </>
  );
}

export default AppLayout;
