import { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { Link, useLocation, useNavigate, useNavigationType } from "react-router-dom";

const MobileNavigationContext = createContext(null);
const LIBRARY_START = "/library/playlists";
const LIBRARY_SECTION = /^\/library\/(playlists|albums|artists|tracks|health)\/?$/;
const DETAIL_PAGE = /^\/(album|artist|playlist)\//;

function sectionFor(pathname) {
  if (pathname === "/") return "home";
  if (/^\/(explore|new-releases|saved-discoveries)(\/|$)/.test(pathname)) return "discover";
  if (pathname === "/search") return "search";
  if (/^\/(library|liked|downloads|album|artist|playlist|smart-playlist)(\/|$)/.test(pathname)) return "library";
  return null;
}

export function MobileNavigationProvider({ mobile, children }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const entries = useRef(new Map());
  const previousEntry = useRef(null);
  const lastLibrarySection = useRef(LIBRARY_START);
  const { pathname, search, hash } = location;
  // The overlay entries share the same browsing location as the page underneath.
  const key = location.state?.musicdeckPlaybackOverlay?.baseKey ?? location.key;
  const to = pathname + search + hash;
  const previous = previousEntry.current;
  const detail = DETAIL_PAGE.test(pathname);
  const knownEntry = entries.current.get(key);
  const source = navigationType === "POP" ? null : previous;
  const entry = useMemo(() => {
    if (knownEntry) return knownEntry;
    const pushed = navigationType === "PUSH";
    const back = detail && source && (
      pushed && source.pathname !== pathname
        ? { to: source.to, steps: 1 }
        : source.back && { to: source.back.to, steps: source.back.steps + Number(pushed) }
    );
    return {
      to,
      pathname,
      back,
      tab: (detail && source?.tab) || sectionFor(pathname),
      searchTo: pathname === "/search" ? to : detail ? source?.searchTo : undefined,
    };
  }, [detail, knownEntry, navigationType, pathname, source, to]);
  const libraryTo = LIBRARY_SECTION.test(pathname) ? to : lastLibrarySection.current;

  useLayoutEffect(() => {
    const history = entries.current;
    history.delete(key);
    history.set(key, entry);
    if (history.size > 100) history.delete(history.keys().next().value);
    previousEntry.current = entry;
    lastLibrarySection.current = libraryTo;
  }, [key, entry, libraryTo]);

  const navigation = useMemo(() => ({ mobile, entry, libraryTo }), [mobile, entry, libraryTo]);
  return <MobileNavigationContext.Provider value={navigation}>
    {children}
  </MobileNavigationContext.Provider>;
}

export function useMobileNavigation() {
  return useContext(MobileNavigationContext);
}

export function DetailBackLink({ fallback, children, ...props }) {
  const navigation = useMobileNavigation();
  const navigate = useNavigate();
  const back = navigation?.mobile ? navigation.entry.back : null;

  return <Link {...props} to={back?.to ?? fallback} onClick={event => {
    if (!back || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    navigate(-back.steps);
  }}>
    {children}
  </Link>;
}
