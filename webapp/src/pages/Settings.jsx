import { useEffect, useRef, useState } from "react";

import {
  analyzeSilence,
  getUserSettings,
  updateUserSettings,
} from "../api/musicdeck";
import { usePlayer } from "../context/PlayerContext";

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
    isReplayGainEnabled: globalReplayGainEnabled = false,
    changeReplayGainEnabled,
  } = player;
  const [silenceTrimEnabled, setSilenceTrimEnabled] = useState(false);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-35);
  const [silenceMinSeconds, setSilenceMinSeconds] = useState(0.5);
  const [crossfadeDuration, setCrossfadeDuration] = useState(
    globalCrossfadeDuration,
  );
  const [streamQuality, setStreamQuality] = useState(globalStreamQuality);
  const [isReplayGainEnabled, setIsReplayGainEnabled] = useState(
    globalReplayGainEnabled,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeMessage, setReanalyzeMessage] = useState("");
  const initialCrossfadePreference = useRef({
    duration: globalCrossfadeDuration,
    change: changeCrossfadeDuration,
  });
  const initialAudioPreferences = useRef({
    streamQuality: globalStreamQuality,
    changeStreamQuality,
    replayGainEnabled: globalReplayGainEnabled,
    changeReplayGainEnabled,
  });

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
        "playback.replayGain.enabled": isReplayGainEnabled,
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

        <section
          className="settings-section settings-section-placeholder"
          aria-labelledby="interface-layout-title"
        >
          <div className="settings-section-heading">
            <span>02</span>
            <h2 id="interface-layout-title">Interface &amp; Layout</h2>
          </div>
          <p>Personal presentation controls will appear here.</p>
        </section>

        <section
          className="settings-section settings-section-placeholder"
          aria-labelledby="data-storage-title"
        >
          <div className="settings-section-heading">
            <span>03</span>
            <h2 id="data-storage-title">Data &amp; Storage</h2>
          </div>
          <p>Library and offline-data controls will appear here.</p>
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
