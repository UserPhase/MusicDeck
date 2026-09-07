import { useEffect, useState } from "react";

import { getLibraryHealth, getLibraryStatistics } from "../api/musicdeck";
import { ErrorState, LoadingState } from "../components/ui/PageState";

function LibraryHealth() {
  const [health, setHealth] = useState(null);
  const [statistics, setStatistics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const [healthData, statisticsData] = await Promise.all([
          getLibraryHealth(),
          getLibraryStatistics(),
        ]);
        if (!cancelled) {
          setHealth(healthData);
          setStatistics(statisticsData);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not load library health.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <LoadingState>Checking library health...</LoadingState>;
  }

  if (error) {
    return <ErrorState>{error}</ErrorState>;
  }

  const summary = health?.summary || {};
  const collection = statistics?.collection || {};

  return (
    <section className="library-section">
      <div className="library-section-header">
        <h2>Library Health</h2>
      </div>

      <div className="search-results" aria-label="Library health summary">
        <div className="search-result"><strong>{summary.albums || 0}</strong><div className="search-result-type">Albums</div></div>
        <div className="search-result"><strong>{summary.tracks || 0}</strong><div className="search-result-type">Tracks</div></div>
        <div className="search-result"><strong>{summary.missingArtwork || 0}</strong><div className="search-result-type">Missing artwork</div></div>
        <div className="search-result"><strong>{summary.metadataIssues || 0}</strong><div className="search-result-type">Metadata issues</div></div>
        <div className="search-result"><strong>{summary.duplicates || 0}</strong><div className="search-result-type">Duplicates</div></div>
        <div className="search-result"><strong>{summary.unavailable || 0}</strong><div className="search-result-type">Unavailable files</div></div>
      </div>

      <div className="library-section-header">
        <h2>Collection Statistics</h2>
      </div>
      <div className="search-results">
        <div className="search-result"><strong>{collection.artists || 0}</strong><div className="search-result-type">Artists</div></div>
        <div className="search-result"><strong>{Math.round((collection.totalDurationSeconds || 0) / 3600)}</strong><div className="search-result-type">Hours</div></div>
        <div className="search-result"><strong>{collection.playedPercentage || 0}%</strong><div className="search-result-type">Played</div></div>
        <div className="search-result"><strong>{collection.favoritePercentage || 0}%</strong><div className="search-result-type">Favorites</div></div>
      </div>

      <div className="library-section-header">
        <h2>Issues</h2>
      </div>
      <div className="search-results">
        {(health?.issues || []).length === 0 ? (
          <div className="library-empty">No library issues detected.</div>
        ) : (
          health.issues.map((issue) => (
            <div className="search-result" key={`${issue.type}:${issue.itemId}`}>
              <div className="search-result-title">{issue.title}</div>
              <div className="search-result-type">{issue.detail}</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default LibraryHealth;
