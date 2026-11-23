import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { usePlayer } from "../../context/PlayerContext";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useRouteScrollRestoration } from "../../hooks/useViewStateStore";
import {
  DEFAULT_LAYOUT_PRESET,
  DOCKED_LIBRARY_QUERY,
  DOCKED_PLAYBACK_QUERY,
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
import TopNavHeader, { NAV_DRAWER_ID, NavDrawerToggle } from "./Headers/TopNavHeader";
import DrawerPlayerBar from "./PlayerBars/DrawerPlayerBar";
import WidgetSidebar from "./WidgetSidebar";
import MobileNavBar from "./MobileNavBar";
import { MobileNavigationProvider } from "./MobileNavigation";
import { useMobilePlaybackOverlays } from "./useMobilePlaybackOverlays";


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
  const queueButtonRef = useRef(null);
  const lyricsButtonRef = useRef(null);
  const previousPanelRef = useRef(null);
  const navToggleRef = useRef(null);
  const mainPanelToggleRef = useRef(null);
  const overlayTriggerRef = useRef(null);
  const previousDesktopPanelRef = useRef(null);
  useRouteScrollRestoration(mainRef);
  const {
    currentSong,
    activeSidebar,
    setActiveSidebar,
    autoOpenSidebar,
  } = usePlayer();
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const dockPlayback = useMediaQuery(DOCKED_PLAYBACK_QUERY);
  const dockLibrary = useMediaQuery(DOCKED_LIBRARY_QUERY);
  const shell = isMobile ? MOBILE_LAYOUT_SHELL : getLayoutPresetConfig(preset).value;
  const config = getLayoutPresetConfig(preset).shell;
  const compactLibrary = !isMobile && config.navigation === "sidebar" && !dockLibrary;
  const usesDrawerNav = shell === "ytmusic" || compactLibrary;
  const overlayPlayback = !isMobile && shell !== "ytmusic" && !dockPlayback;
  const [isNavDrawerOpen, setIsNavDrawerOpen] = useState(false);
  const previousTrackIdRef = useRef(null);
  const { panel: mobilePanel, hasNowPlaying, open: openMobilePanel, close: closeMobilePanel } =
    useMobilePlaybackOverlays(isMobile);
  const isPanelOpen = isMobile ? Boolean(mobilePanel) : activeSidebar !== "none";
  const desktopOverlayOpen = overlayPlayback && isPanelOpen;
  const mobileNowPlayingOpen = mobilePanel === "now-playing" || mobilePanel === "lyrics";
  const mobileQueueOpen = mobilePanel === "queue";
  const closePanel = useCallback(() => setActiveSidebar("none"), [setActiveSidebar]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.layoutShell = shell;
    root.toggleAttribute("data-library-drawer", compactLibrary);
    root.toggleAttribute("data-playback-overlay", overlayPlayback);
    return () => {
      delete root.dataset.layoutShell;
      root.removeAttribute("data-library-drawer");
      root.removeAttribute("data-playback-overlay");
    };
  }, [shell, compactLibrary, overlayPlayback]);

  const pageUrl = location.pathname + location.search + location.hash;
  useEffect(() => {
    const previous = previousPanelRef.current;
    previousPanelRef.current = { panel: mobilePanel, pageUrl };
    const returning = previous?.pageUrl === pageUrl ? previous.panel : undefined;
    let target;
    if (mobilePanel === "now-playing") {
      if (returning === "queue") target = queueButtonRef.current;
      if (returning === "lyrics") target = lyricsButtonRef.current;
      target ??= nowPlayingCloseRef.current;
    } else if (mobilePanel === "queue") {
      target = queueCloseRef.current;
    } else if (!mobilePanel && returning) {
      target = nowPlayingButtonRef.current;
    }
    target?.focus({ preventScroll: true });
  }, [mobilePanel, pageUrl]);

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
  }, [location.pathname, shell, usesDrawerNav]);

  useEffect(() => {
    if (compactLibrary && isNavDrawerOpen) {
      document.getElementById(NAV_DRAWER_ID)?.querySelector(".nav-item")?.focus({ preventScroll: true });
    }
  }, [compactLibrary, isNavDrawerOpen]);

  useEffect(() => {
    const previous = previousDesktopPanelRef.current;
    previousDesktopPanelRef.current = desktopOverlayOpen ? activeSidebar : null;
    if (desktopOverlayOpen && previous !== activeSidebar && !isNavDrawerOpen) {
      overlayTriggerRef.current ??= document.activeElement;
      const close = activeSidebar === "queue" ? queueCloseRef.current : nowPlayingCloseRef.current;
      close?.focus({ preventScroll: true });
    } else if (!isPanelOpen || isMobile) {
      const trigger = overlayTriggerRef.current;
      overlayTriggerRef.current = null;
      if (!isMobile && trigger) {
        const target = trigger.isConnected && trigger !== document.body ? trigger : mainPanelToggleRef.current;
        target?.focus({ preventScroll: true });
      }
    }
  }, [activeSidebar, desktopOverlayOpen, isMobile, isNavDrawerOpen, isPanelOpen]);

  const closeNavDrawer = useCallback(() => {
    setIsNavDrawerOpen(false);
    navToggleRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    // The command palette uses the shared desktop sidebar action.
    if (!isMobile || activeSidebar === "none") return;
    openMobilePanel(activeSidebar);
    setActiveSidebar("none");
  }, [activeSidebar, isMobile, openMobilePanel, setActiveSidebar]);

  useEffect(() => {
    if (!isNavDrawerOpen && !desktopOverlayOpen && (!mobilePanel || mobilePanel === "lyrics")) return undefined;
    const closeOnEscape = (event) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (isNavDrawerOpen) closeNavDrawer();
      else if (desktopOverlayOpen) closePanel();
      else closeMobilePanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeMobilePanel, closeNavDrawer, closePanel, desktopOverlayOpen, isNavDrawerOpen, mobilePanel]);

  // Auto-open Now Playing on a new track only where the panel docks beside
  // the page; in sheet/widget/mobile shells it would cover the content.
  const canAutoOpenPanel = dockPlayback && (shell === "spotify" || shell === "apple");
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
  const leading = usesDrawerNav && <NavDrawerToggle buttonRef={navToggleRef}
    drawer={{ isOpen: isNavDrawerOpen, onToggle: toggleNavDrawer }} />;

  let header;
  if (shell === MOBILE_LAYOUT_SHELL) header = <Topbar key="header-mobile" mobile />;
  else if (config.header === "player") header = <Topbar key="header-player" leading={leading} playerSlot={<AppleHeaderPlayer />} />;
  else if (config.header === "topnav") header = <TopNavHeader key="header-topnav" leading={leading} />;
  else header = <Topbar key="header-standard" leading={leading} />;

  let player = null;
  if (shell === MOBILE_LAYOUT_SHELL) {
    player = <Player key="player-bar" mobile hidden={mobileNowPlayingOpen} nowPlayingButtonRef={nowPlayingButtonRef}
      onOpenNowPlaying={() => openMobilePanel("now-playing")} />;
  } else if (config.player === "bar") {
    player = <Player key="player-bar" isQueueSidebarOpen={activeSidebar === "queue"} onToggleQueueSidebar={toggleQueue} />;
  } else if (config.player === "drawer") {
    player = <DrawerPlayerBar key="player-drawer" />;
  }

  const showWidgets = shell !== MOBILE_LAYOUT_SHELL && config.aside === "widgets";
  const showPanelToggle = shell === "spotify" && activeSidebar === "none";

  return (
    <MobileNavigationProvider mobile={isMobile}>
      <div inert={mobileNowPlayingOpen || undefined}>
        {header}
        {usesDrawerNav && isNavDrawerOpen && (
          <div key="nav-scrim" className="nav-drawer-scrim" aria-hidden="true" onClick={closeNavDrawer} />
        )}
        <Sidebar key="sidebar" id={NAV_DRAWER_ID} />
        <main ref={mainRef} key="main" className={`main${isPanelOpen ? " sidebar-open" : ""}`}
          inert={mobileQueueOpen || desktopOverlayOpen || (compactLibrary && isNavDrawerOpen) || undefined}>
          {showPanelToggle && (
            <button
              className="main-now-playing-toggle"
              type="button"
              ref={mainPanelToggleRef}
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
        {mobileQueueOpen && <div className="mobile-queue-scrim" aria-hidden="true" onClick={closeMobilePanel} />}
        {desktopOverlayOpen && <div className="playback-overlay-scrim" aria-hidden="true" onClick={closePanel} />}
        <QueueSidebar
          key="queue-panel"
          isOpen={isMobile ? mobileQueueOpen : activeSidebar === "queue"}
          onClose={isMobile ? closeMobilePanel : closePanel}
          closeButtonRef={queueCloseRef}
        />
        {player}
        {isMobile && <MobileNavBar key="mobile-nav" />}
      </div>
      <NowPlayingSidebar
        key="now-playing-panel"
        isOpen={isMobile ? hasNowPlaying : activeSidebar === "now-playing"}
        covered={mobileQueueOpen}
        onClose={isMobile ? closeMobilePanel : closePanel}
        onOpenQueue={isMobile ? () => openMobilePanel("queue") : () => setActiveSidebar("queue")}
        queueButtonRef={queueButtonRef}
        fullScreenLyrics={isMobile ? mobilePanel === "lyrics" : undefined}
        onOpenLyrics={isMobile ? () => openMobilePanel("lyrics") : undefined}
        lyricsButtonRef={lyricsButtonRef}
        mobile={isMobile}
        closeButtonRef={nowPlayingCloseRef}
      />
    </MobileNavigationProvider>
  );
}

export default AppLayout;
