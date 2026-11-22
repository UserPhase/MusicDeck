import { useCallback, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export function useMobilePlaybackOverlays(enabled) {
  const location = useLocation();
  const navigate = useNavigate();
  const pendingEntry = useRef(null);
  const entry = location.state?.musicdeckPlaybackOverlay;
  const panels = enabled && entry ? entry.panels : [];
  const key = location.key;

  useLayoutEffect(() => { pendingEntry.current = null; }, [key]);

  const open = useCallback((panel) => {
    const panels = entry?.panels ?? [];
    if (!enabled || panels.includes(panel) || pendingEntry.current === location.key) return;
    pendingEntry.current = location.key;
    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, {
      state: {
        ...location.state,
        musicdeckPlaybackOverlay: {
          baseKey: entry?.baseKey ?? location.key,
          panels: [...panels, panel],
        },
      },
    });
  }, [enabled, entry, location, navigate]);

  const close = useCallback(() => {
    if (!enabled || !entry || pendingEntry.current === key) return;
    pendingEntry.current = key;
    navigate(-1);
  }, [enabled, entry, key, navigate]);

  return { panel: panels.at(-1), hasNowPlaying: panels.includes("now-playing"), open, close };
}
