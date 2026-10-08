import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { getPublicConfig } from "../api/musicdeck";

export const DEFAULT_APP_NAME = "MusicDeck";
const APP_NAME_STORAGE_KEY = "musicdeckAppName";

function normalizeAppName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_APP_NAME;
}

function readCachedAppName() {
  try {
    return normalizeAppName(localStorage.getItem(APP_NAME_STORAGE_KEY));
  } catch {
    return DEFAULT_APP_NAME;
  }
}

/**
 * Splits a brand name into a lead and an accented tail for the wordmark:
 * "MusicDeck" -> ["Music", "Deck"], "Basement FM" -> ["Basement ", "FM"].
 * Names without an obvious seam render without an accent.
 */
export function splitBrandName(name) {
  const lastSpace = name.lastIndexOf(" ");
  if (lastSpace > 0) return [name.slice(0, lastSpace + 1), name.slice(lastSpace + 1)];

  for (let index = name.length - 1; index > 0; index -= 1) {
    const char = name[index];
    const previous = name[index - 1];
    if (char !== char.toLowerCase() && previous !== previous.toUpperCase()) {
      return [name.slice(0, index), name.slice(index)];
    }
  }

  return [name, ""];
}

const BrandingContext = createContext({
  appName: DEFAULT_APP_NAME,
  setAppName: () => {},
});

export function BrandingProvider({ children }) {
  const [appName, setAppNameState] = useState(readCachedAppName);

  const setAppName = useCallback((value) => {
    setAppNameState(normalizeAppName(value));
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => getPublicConfig())
      .then((config) => {
        if (!cancelled) setAppName(config?.appName);
      })
      .catch(() => {
        // Keep the cached or default name when the config is unreachable.
      });
    return () => {
      cancelled = true;
    };
  }, [setAppName]);

  useEffect(() => {
    document.title = appName;
    try {
      localStorage.setItem(APP_NAME_STORAGE_KEY, appName);
    } catch {
      // The cache only prevents a flash of the default name on load.
    }
  }, [appName]);

  const value = useMemo(() => ({ appName, setAppName }), [appName, setAppName]);

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding() {
  return useContext(BrandingContext);
}

export function BrandWordmark() {
  const { appName } = useBranding();
  const [lead, accent] = splitBrandName(appName);
  return (
    <>
      {lead}
      {accent && <span>{accent}</span>}
    </>
  );
}
