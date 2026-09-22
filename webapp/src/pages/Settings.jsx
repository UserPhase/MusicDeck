import { useCallback, useEffect, useRef, useState } from "react";

import {
  analyzeSilence,
  getUserSettings,
  updateUserSettings,
} from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";
import {
  clearLocalBrowserCache,
  formatStorageSize,
  getBrowserStorageUsage,
} from "../utils/browserCache";
import {
  applySettingsBackup,
  createSettingsBackup,
  downloadSettingsBackup,
  MAX_SETTINGS_BACKUP_BYTES,
} from "../utils/settingsBackup";
import { ACCENT_COLORS, DEFAULT_ACCENT_COLOR, normalizeAccentColor } from "../utils/accentColors";

function parseSettingValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getSetting(settings, key, fallback) {
  const setting = settings.find((item) => item.key === key);
  return setting ? parseSettingValue(setting.value) : fallback;
}

function Settings() {
  const player = usePlayer() || {};
  const {
    currentSong = null,
    crossfadeDuration: globalCrossfadeDuration = 0,
    changeCrossfadeDuration,
    streamQuality: globalStreamQuality = "original",
    changeStreamQuality,
    downloadQuality: globalDownloadQuality = "320kbps",
    changeDownloadQuality,
    isReplayGainEnabled: globalReplayGainEnabled = false,
    changeReplayGainEnabled,
    layoutDensity: globalLayoutDensity = "comfortable",
    changeLayoutDensity,
    accentColor: globalAccentColor = DEFAULT_ACCENT_COLOR,
    changeAccentColor,
    autoOpenSidebar: globalAutoOpenSidebar = false,
    changeAutoOpenSidebar,
    isAutoplayEnabled: globalAutoplayEnabled = true,
    changeAutoplayEnabled,
  } = player;
  const [silenceTrimEnabled, setSilenceTrimEnabled] = useState(false);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-35);
  const [silenceMinSeconds, setSilenceMinSeconds] = useState(0.5);
  const [crossfadeDuration, setCrossfadeDuration] = useState(
    globalCrossfadeDuration,
  );
  const [streamQuality, setStreamQuality] = useState(globalStreamQuality);
  const [downloadQuality, setDownloadQuality] = useState(globalDownloadQuality);
  const [isReplayGainEnabled, setIsReplayGainEnabled] = useState(
    globalReplayGainEnabled,
  );
  const [layoutDensity, setLayoutDensity] = useState(globalLayoutDensity);
  const [accentColor, setAccentColor] = useState(globalAccentColor);
  const [autoOpenSidebar, setAutoOpenSidebar] = useState(globalAutoOpenSidebar);
  const [isAutoplayEnabled, setIsAutoplayEnabled] = useState(globalAutoplayEnabled);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeMessage, setReanalyzeMessage] = useState("");
  const [storageUsage, setStorageUsage] = useState({
    supported: false,
    usage: null,
    quota: null,
  });
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [cacheMessage, setCacheMessage] = useState("");
  const initialCrossfadePreference = useRef({
    duration: globalCrossfadeDuration,
    change: changeCrossfadeDuration,
  });
  const initialAudioPreferences = useRef({
    streamQuality: globalStreamQuality,
    changeStreamQuality,
    downloadQuality: globalDownloadQuality,
    changeDownloadQuality,
    replayGainEnabled: globalReplayGainEnabled,
    changeReplayGainEnabled,
  });
  const initialLayoutPreference = useRef({
    density: globalLayoutDensity,
    change: changeLayoutDensity,
    accentColor: globalAccentColor,
    changeAccentColor,
  });
  const initialQueuePreferences = useRef({
    autoOpenSidebar: globalAutoOpenSidebar,
    changeAutoOpenSidebar,
    autoplayEnabled: globalAutoplayEnabled,
    changeAutoplayEnabled,
  });

  const refreshStorageUsage = useCallback(async () => {
    const estimate = await getBrowserStorageUsage();
    setStorageUsage(estimate || {
      supported: false,
      usage: null,
      quota: null,
    });
  }, []);

  useEffect(() => {
    refreshStorageUsage();
  }, [refreshStorageUsage]);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        setLoading(true);
        setError(null);
        const settings = await getUserSettings();

        if (!cancelled) {
          setSilenceTrimEnabled(
            Boolean(getSetting(settings, "playback.silenceTrim.enabled", false)),
          );
          setSilenceThresholdDb(
            Number(getSetting(settings, "playback.silenceTrim.thresholdDb", -35)),
          );
          setSilenceMinSeconds(
            Number(
              getSetting(settings, "playback.silenceTrim.minSilenceSeconds", 0.5),
            ),
          );

          const nextCrossfadeDuration = Math.max(
            0,
            Math.min(
              12,
              Number(
                getSetting(
                  settings,
                  "playback.crossfadeDuration",
                  initialCrossfadePreference.current.duration,
                ),
              ) || 0,
            ),
          );

          setCrossfadeDuration(nextCrossfadeDuration);
          initialCrossfadePreference.current.change?.(nextCrossfadeDuration);

          const nextStreamQuality = ["128", "320", "original"].includes(
            getSetting(
              settings,
              "playback.streamQuality",
              initialAudioPreferences.current.streamQuality,
            ),
          )
            ? getSetting(
                settings,
                "playback.streamQuality",
                initialAudioPreferences.current.streamQuality,
              )
            : "original";

          setStreamQuality(nextStreamQuality);
          initialAudioPreferences.current.changeStreamQuality?.(nextStreamQuality);

          const nextDownloadQuality = [
            "lossless",
            "320kbps",
            "256kbps",
            "192kbps",
            "128kbps",
          ].includes(getSetting(
            settings,
            "playback.downloadQuality",
            initialAudioPreferences.current.downloadQuality,
          ))
            ? getSetting(
                settings,
                "playback.downloadQuality",
                initialAudioPreferences.current.downloadQuality,
              )
            : "320kbps";

          setDownloadQuality(nextDownloadQuality);
          initialAudioPreferences.current.changeDownloadQuality?.(nextDownloadQuality);

          const nextReplayGainEnabled = Boolean(
            getSetting(
              settings,
              "playback.replayGain.enabled",
              initialAudioPreferences.current.replayGainEnabled,
            ),
          );

          setIsReplayGainEnabled(nextReplayGainEnabled);
          initialAudioPreferences.current.changeReplayGainEnabled?.(
            nextReplayGainEnabled,
          );

          const nextLayoutDensity = getSetting(
            settings,
            "ui.layoutDensity",
            initialLayoutPreference.current.density,
          ) === "compact"
            ? "compact"
            : "comfortable";

          setLayoutDensity(nextLayoutDensity);
          initialLayoutPreference.current.change?.(nextLayoutDensity);

          const nextAccentColor = normalizeAccentColor(getSetting(
            settings,
            "ui.accentColor",
            initialLayoutPreference.current.accentColor,
          ));
          setAccentColor(nextAccentColor);
          initialLayoutPreference.current.changeAccentColor?.(nextAccentColor);

          const nextAutoOpenSidebar = Boolean(getSetting(
            settings,
            "ui.autoOpenSidebar",
            initialQueuePreferences.current.autoOpenSidebar,
          ));
          setAutoOpenSidebar(nextAutoOpenSidebar);
          initialQueuePreferences.current.changeAutoOpenSidebar?.(nextAutoOpenSidebar);

          const nextAutoplayEnabled = Boolean(getSetting(
            settings,
            "playback.autoplay.enabled",
            initialQueuePreferences.current.autoplayEnabled,
          ));
          setIsAutoplayEnabled(nextAutoplayEnabled);
          initialQueuePreferences.current.changeAutoplayEnabled?.(nextAutoplayEnabled);

        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Could not load settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();

    try {
      setSaving(true);
      setMessage("");
      setError(null);
      await updateUserSettings({
        "playback.silenceTrim.enabled": silenceTrimEnabled,
        "playback.silenceTrim.thresholdDb": Number(silenceThresholdDb),
        "playback.silenceTrim.minSilenceSeconds": Number(silenceMinSeconds),
        "playback.crossfadeDuration": Number(crossfadeDuration),
        "playback.streamQuality": streamQuality,
        "playback.downloadQuality": downloadQuality,
        "playback.replayGain.enabled": isReplayGainEnabled,
        "ui.layoutDensity": layoutDensity,
        "ui.accentColor": accentColor,
        "ui.autoOpenSidebar": autoOpenSidebar,
        "playback.autoplay.enabled": isAutoplayEnabled,
      });
      setMessage("Settings saved.");
    } catch (err) {
      setError(err.message || "Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  function handleCrossfadeChange(event) {
    const nextDuration = Number(event.target.value);

    setCrossfadeDuration(nextDuration);
    changeCrossfadeDuration?.(nextDuration);

    if (!changeCrossfadeDuration) {
      try {
        localStorage.setItem(
          "playerCrossfadeDuration",
          String(nextDuration),
        );
      } catch {
        // The server save remains available if browser storage is blocked.
      }
    }
  }

  function handleStreamQualityChange(event) {
    const nextQuality = event.target.value;
    setStreamQuality(nextQuality);
    changeStreamQuality?.(nextQuality);

    if (!changeStreamQuality) {
      try {
        localStorage.setItem("playerStreamQuality", nextQuality);
      } catch {
        // Saving to the backend remains available if browser storage is blocked.
      }
    }
  }

  function handleDownloadQualityChange(event) {
    const nextQuality = event.target.value;
    setDownloadQuality(nextQuality);
    changeDownloadQuality?.(nextQuality);

    if (!changeDownloadQuality) {
      try {
        localStorage.setItem("playerDownloadQuality", nextQuality);
      } catch {
        // Saving to the backend remains available if browser storage is blocked.
      }
    }
  }

  function handleReplayGainChange(event) {
    const nextEnabled = event.target.checked;
    setIsReplayGainEnabled(nextEnabled);
    changeReplayGainEnabled?.(nextEnabled);

    if (!changeReplayGainEnabled) {
      try {
        localStorage.setItem("playerReplayGainEnabled", String(nextEnabled));
      } catch {
        // Saving to the backend remains available if browser storage is blocked.
      }
    }
  }

  function handleLayoutDensityChange(nextDensity) {
    setLayoutDensity(nextDensity);
    changeLayoutDensity?.(nextDensity);

    if (!changeLayoutDensity) {
      try {
        localStorage.setItem("playerLayoutDensity", nextDensity);
      } catch {
        // Saving to the backend remains available if browser storage is blocked.
      }
    }
  }

  function handleAccentColorChange(nextAccentColor) {
    const normalizedColor = normalizeAccentColor(nextAccentColor);
    setAccentColor(normalizedColor);
    changeAccentColor?.(normalizedColor);
    if (!changeAccentColor) {
      localStorage.setItem("playerAccentColor", normalizedColor);
      document.documentElement.style.setProperty("--color-accent", normalizedColor);
    }
  }

  function handleQueuePreferenceChange(value, setValue, changeValue, storageKey) {
    const nextEnabled = value.target.checked;
    setValue(nextEnabled);
    changeValue?.(nextEnabled);

    if (!changeValue) {
      try {
        localStorage.setItem(storageKey, String(nextEnabled));
      } catch {
        // Saving to the backend remains available if browser storage is blocked.
      }
    }
  }

  async function handleClearCache() {
    try {
      setIsClearingCache(true);
      setCacheMessage("");
      await clearLocalBrowserCache();
      await refreshStorageUsage();
      setCacheMessage("Local cache cleared. Your preferences and session are still intact.");
    } catch {
      setCacheMessage("Could not clear the local cache. Please try again.");
    } finally {
      setIsClearingCache(false);
    }
  }

  function handleExportBackup() {
    downloadSettingsBackup(createSettingsBackup());
    setCacheMessage("Preferences exported successfully.");
  }

  async function handleImportBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > MAX_SETTINGS_BACKUP_BYTES) {
        throw new Error("That backup file is too large.");
      }
      const backup = JSON.parse(await file.text());
      applySettingsBackup(backup);
      setCacheMessage("Preferences restored. Applying your settings now...");
      window.setTimeout(() => window.location.reload(), 250);
    } catch (err) {
      setCacheMessage(err.message || "That backup could not be imported.");
    }
  }

  async function handleReanalyze() {
    if (!currentSong) return;

    try {
      setReanalyzing(true);
      setReanalyzeMessage("");
      await analyzeSilence(currentSong.id, {
        thresholdDb: Number(silenceThresholdDb),
        minSilenceSeconds: Number(silenceMinSeconds),
      });
      setReanalyzeMessage("Re-analysis complete for the current track.");
    } catch (err) {
      setReanalyzeMessage(
        err.message || "Could not re-analyze the current track.",
      );
    } finally {
      setReanalyzing(false);
    }
  }

  const storagePercent = storageUsage.supported && storageUsage.quota > 0
    ? Math.min(100, Math.max(0, (storageUsage.usage / storageUsage.quota) * 100))
    : 0;

  if (loading) return <div className="loading">Loading settings...</div>;

  return (
    <div className="settings-page">
      <header className="settings-header">
        <span>Preferences</span>
        <h1>Settings</h1>
        <p>Keep playback precise and the rest out of your way.</p>
      </header>

      {error && <div className="error">{error}</div>}

      <form className="settings-form" onSubmit={handleSubmit}>
        <section className="settings-section" aria-labelledby="audio-playback-title">
          <div className="settings-section-heading">
            <span>01</span>
            <h2 id="audio-playback-title">Audio &amp; Playback</h2>
          </div>

          <article className="settings-row settings-row-featured">
            <div className="settings-row-copy">
              <h3>Automatic Silence Trimming</h3>
              <p>
                Skip detected silence at the beginning and end of tracks during
                playback.
              </p>
            </div>
            <label
              className="settings-switch"
              aria-label="Automatic Silence Trimming"
            >
              <input
                type="checkbox"
                checked={silenceTrimEnabled}
                onChange={(event) => setSilenceTrimEnabled(event.target.checked)}
              />
              <span aria-hidden="true" />
            </label>
          </article>

          <div className="settings-detail-grid" aria-label="Silence trimming controls">
            <label>
              <span>Silence threshold (dB)</span>
              <input
                type="number"
                step="1"
                value={silenceThresholdDb}
                onChange={(event) => setSilenceThresholdDb(event.target.value)}
                disabled={!silenceTrimEnabled}
              />
            </label>
            <label>
              <span>Minimum silence duration (seconds)</span>
              <input
                type="number"
                min="0"
                step="0.1"
                value={silenceMinSeconds}
                onChange={(event) => setSilenceMinSeconds(event.target.value)}
                disabled={!silenceTrimEnabled}
              />
            </label>
          </div>

          <div className="settings-row-actions">
            <button
              type="button"
              className="account-secondary"
              onClick={handleReanalyze}
              disabled={!currentSong || reanalyzing}
            >
              {reanalyzing ? "Analyzing..." : "Re-analyze current track"}
            </button>
            {reanalyzeMessage && (
              <span className="settings-inline-message">{reanalyzeMessage}</span>
            )}
          </div>

          <article className="settings-row settings-crossfade-row">
            <div className="settings-row-copy">
              <h3>Crossfade</h3>
              <p>Blend the end of one track into the beginning of the next.</p>
            </div>

            <div className="settings-range-control">
              <label htmlFor="crossfade-duration">Crossfade duration</label>
              <input
                id="crossfade-duration"
                type="range"
                min="0"
                max="12"
                step="1"
                value={crossfadeDuration}
                onChange={handleCrossfadeChange}
                style={{ "--range-progress": `${(crossfadeDuration / 12) * 100}%` }}
              />
              <output htmlFor="crossfade-duration">
                {crossfadeDuration} s
              </output>
            </div>
          </article>

          <article className="settings-row">
            <div className="settings-row-copy">
              <h3>Streaming Quality</h3>
              <p>Choose the maximum bitrate used when your music server transcodes.</p>
            </div>
            <label className="settings-select-control">
              <span>Streaming quality</span>
              <select value={streamQuality} onChange={handleStreamQualityChange}>
                <option value="128">128 kbps</option>
                <option value="320">320 kbps</option>
                <option value="original">Original/Lossless</option>
              </select>
            </label>
          </article>

          <article className="settings-row">
            <div className="settings-row-copy">
              <h3>Download Quality</h3>
              <p>Choose the format used when saving music for offline playback.</p>
            </div>
            <label className="settings-select-control">
              <span>Download quality</span>
              <select value={downloadQuality} onChange={handleDownloadQualityChange}>
                <option value="lossless">Lossless (FLAC / Original)</option>
                <option value="320kbps">320 kbps (High Quality MP3)</option>
                <option value="256kbps">256 kbps (Medium)</option>
                <option value="192kbps">192 kbps (Standard)</option>
                <option value="128kbps">128 kbps (Data Saver)</option>
              </select>
            </label>
          </article>

          <article className="settings-row">
            <div className="settings-row-copy">
              <h3>Volume Normalization (ReplayGain)</h3>
              <p>Use track ReplayGain metadata to keep playback levels more consistent.</p>
            </div>
            <label
              className="settings-switch"
              aria-label="Volume Normalization (ReplayGain)"
            >
              <input
                type="checkbox"
                checked={isReplayGainEnabled}
                onChange={handleReplayGainChange}
              />
              <span aria-hidden="true" />
            </label>
          </article>
        </section>

        <section className="settings-section" aria-labelledby="interface-layout-title">
          <div className="settings-section-heading">
            <span>02</span>
            <h2 id="interface-layout-title">Interface &amp; Layout</h2>
          </div>

          <article className="settings-row settings-layout-density-row">
            <div className="settings-row-copy">
              <h3>Layout Density</h3>
              <p>Choose how much breathing room track lists use throughout the app.</p>
            </div>
            <div
              className="settings-density-control"
              role="radiogroup"
              aria-label="Layout Density"
            >
              <span
                className={`settings-density-indicator${layoutDensity === "compact" ? " compact" : ""}`}
                aria-hidden="true"
              />
              <button
                type="button"
                role="radio"
                aria-checked={layoutDensity === "comfortable"}
                className={layoutDensity === "comfortable" ? "active" : ""}
                onClick={() => handleLayoutDensityChange("comfortable")}
              >
                Comfortable
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={layoutDensity === "compact"}
                className={layoutDensity === "compact" ? "active" : ""}
                onClick={() => handleLayoutDensityChange("compact")}
              >
                Compact
              </button>
            </div>
          </article>

          <article className="settings-row settings-accent-row">
            <div className="settings-row-copy">
              <h3>Accent Color</h3>
              <p>Choose the highlight used for playback controls and active states.</p>
            </div>
            <div className="settings-accent-swatches" role="radiogroup" aria-label="Accent Color">
              {ACCENT_COLORS.map((accent) => (
                <button
                  key={accent.id}
                  type="button"
                  role="radio"
                  aria-checked={accentColor === accent.value}
                  aria-label={accent.label}
                  className={accentColor === accent.value ? "active" : ""}
                  style={{ "--swatch-color": accent.value }}
                  onClick={() => handleAccentColorChange(accent.value)}
                >
                  <span aria-hidden="true" />
                </button>
              ))}
            </div>
          </article>
        </section>

        <section className="settings-section" aria-labelledby="queue-behavior-title">
          <div className="settings-section-heading">
            <span>03</span>
            <h2 id="queue-behavior-title">Queue &amp; Behavior</h2>
          </div>

          <article className="settings-row">
            <div className="settings-row-copy">
              <h3>Auto-Open Now Playing Sidebar</h3>
              <p>Automatically open the Now Playing sidebar when you start a new song.</p>
            </div>
            <label className="settings-switch" aria-label="Auto-Open Now Playing Sidebar">
              <input
                type="checkbox"
                checked={autoOpenSidebar}
                onChange={(event) => handleQueuePreferenceChange(event, setAutoOpenSidebar, changeAutoOpenSidebar, "playerAutoOpenSidebar")}
              />
              <span aria-hidden="true" />
            </label>
          </article>

          <article className="settings-row">
            <div className="settings-row-copy">
              <h3>Autoplay / Endless Radio</h3>
              <p>Keep playing similar or random tracks when your queue ends.</p>
            </div>
            <label className="settings-switch" aria-label="Autoplay / Endless Radio">
              <input
                type="checkbox"
                checked={isAutoplayEnabled}
                onChange={(event) => handleQueuePreferenceChange(event, setIsAutoplayEnabled, changeAutoplayEnabled, "playerAutoplayEnabled")}
              />
              <span aria-hidden="true" />
            </label>
          </article>

        </section>

        <section className="settings-section" aria-labelledby="data-storage-title">
          <div className="settings-section-heading">
            <span>04</span>
            <h2 id="data-storage-title">Data &amp; Storage</h2>
          </div>

          <div className="settings-storage-card">
            <div className="settings-storage-card-header">
              <div>
                <h3>Local browser storage</h3>
                <p>Artwork, track metadata, and offline cache stored on this device.</p>
              </div>
              <button
                className="settings-storage-refresh"
                type="button"
                onClick={refreshStorageUsage}
              >
                Refresh
              </button>
            </div>

            {storageUsage.supported ? (
              <>
                <div className="settings-storage-amount">
                  <strong>{formatStorageSize(storageUsage.usage)}</strong>
                  <span>of {formatStorageSize(storageUsage.quota)} used</span>
                </div>
                <div
                  className="settings-storage-meter"
                  role="progressbar"
                  aria-label="Local browser storage usage"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow={Math.round(storagePercent)}
                >
                  <span
                    style={{
                      width: `${storagePercent}%`,
                    }}
                  />
                </div>
              </>
            ) : (
              <p className="settings-storage-unavailable">
                Storage usage is unavailable in this browser.
              </p>
            )}
          </div>

          <article className="settings-row settings-cache-row">
            <div className="settings-row-copy">
              <h3>Clear Local Cache</h3>
              <p>Deletes cached album art and normalized track metadata. Your preferences and login session will not be deleted.</p>
            </div>
            <button
              className="settings-cache-button"
              type="button"
              onClick={handleClearCache}
              disabled={isClearingCache}
            >
              {isClearingCache ? "Clearing..." : "Clear Cache"}
            </button>
          </article>
          <article className="settings-row settings-backup-row">
            <div className="settings-row-copy">
              <h3>Backup &amp; Restore Preferences</h3>
              <p>Move your playback and interface preferences to another device.</p>
            </div>
            <div className="settings-backup-actions">
              <button type="button" className="settings-storage-refresh" onClick={handleExportBackup}>Export Backup</button>
              <label className="settings-cache-button settings-import-button">
                Import Backup
                <input type="file" accept="application/json,.json" onChange={handleImportBackup} />
              </label>
            </div>
          </article>
          {cacheMessage && <p className="settings-cache-message" role="status">{cacheMessage}</p>}
        </section>

        <div className="settings-submit-row">
          {message && <span className="success">{message}</span>}
          <button type="submit" className="account-primary" disabled={saving}>
            {saving ? "Saving..." : "Save settings"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default Settings;
