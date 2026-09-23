import { getExternalCharts } from "../api/musicdeck";

// Share one in-flight request across Explore's four chart shelves. The server
// caches the result, while a later visit can request a fresh chart.
export function createExternalDiscoveryService(loadCharts = getExternalCharts) {
  let pending = null;
  const charts = () => {
    if (!pending) {
      pending = Promise.resolve().then(loadCharts).finally(() => {
        pending = null;
      });
    }
    return pending;
  };

  return {
    getFeatured: async () => (await charts()).albums.slice(0, 3),
    getPopularArtists: async () => (await charts()).artists,
    getPopularAlbums: async () => (await charts()).albums,
    getPopularTracks: async () => (await charts()).tracks,
    getMoods: async () => [
      { name: "Late night", tone: "#4c278a", symbol: "☾" },
      { name: "Focus", tone: "#176e74", symbol: "◈" },
      { name: "Energy", tone: "#a43f3e", symbol: "✦" },
      { name: "Slow down", tone: "#286487", symbol: "◒" },
      { name: "Road trip", tone: "#8f642d", symbol: "◇" },
      { name: "Sunday", tone: "#52783e", symbol: "✳" },
      { name: "After dark", tone: "#783b70", symbol: "◎" },
      { name: "Reset", tone: "#246b82", symbol: "✺" },
    ],
  };
}

export const externalDiscoveryService = createExternalDiscoveryService();
