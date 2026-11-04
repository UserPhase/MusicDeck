import { lazy, Suspense, useEffect, useRef, useState } from "react";

import {
  analyzeSilence,
  getUserSettings,
  updateUserSettings,
  USER_SETTINGS_CHANGED_EVENT,
} from "../api/musicdeck";
import { DEFAULT_CROSSFADE_SECONDS, clampCrossfadeDuration, isTransitionMode, usePlayer } from "../context/PlayerContext";
import LoudnessScanControl from "../components/LoudnessScanControl";
import PlayerSettings from "../components/PlayerSettings";
import DataExportPanel from "../components/settings/DataExportPanel";
import OfflineStoragePanel from "../components/settings/OfflineStoragePanel";
import TasteProfileView from "../views/settings/TasteProfileView";
import { isShuffleMode } from "../utils/shuffle";
import SilenceScanControl from "../components/SilenceScanControl";
import { DEFAULT_LOUDNESS_TARGET, LOUDNESS_TARGETS } from "../utils/loudness";
import {
  applySettingsBackup,
  createSettingsBackup,
  downloadSettingsBackup,
  MAX_SETTINGS_BACKUP_BYTES,
} from "../utils/settingsBackup";
import { ACCENT_COLORS, DEFAULT_ACCENT_COLOR, normalizeAccentColor } from "../utils/accentColors";
import {
  getActiveTheme,
  normalizeTheme,
  saveThemePreference,
  THEME_OPTIONS,
  THEME_SETTING_KEY,
} from "../utils/theme";
import {
  getActiveLayoutPreset,
  LAYOUT_PRESET_OPTIONS,
  LAYOUT_PRESET_SETTING_KEY,
  normalizeLayoutPreset,
  saveLayoutPresetPreference,
} from "../utils/layoutPreset";

const EqualizerSettings = lazy(() => import("../components/settings/EqualizerSettings"));

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
    crossfadeDuration: globalCrossfadeDuration = DEFAULT_CROSSFADE_SECONDS,
    changeCrossfadeDuration,
    transitionMode: globalTransitionMode = "gapless",
    changeTransitionMode,
    shuffleMode: globalShuffleMode = "standard",
    changeShuffleMode,
    isAlbumAware: globalAlbumAware = false,
    changeAlbumAware,
    streamQuality: globalStreamQuality = "original",
    changeStreamQuality,
    downloadQuality: globalDownloadQuality = "320kbps",
    changeDownloadQuality,
    isReplayGainEnabled: globalReplayGainEnabled = true,
    changeReplayGainEnabled,
    normalizationTarget: globalNormalizationTarget = DEFAULT_LOUDNESS_TARGET,
    changeNormalizationTarget,
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
  const [crossfadeDuration, setCrossfadeDuration] = useState(() =>
    clampCrossfadeDuration(globalCrossfadeDuration),
  );
  const [transitionMode, setTransitionMode] = useState(globalTransitionMode);
  const [shuffleMode, setShuffleMode] = useState(globalShuffleMode);
  const [isAlbumAware, setIsAlbumAware] = useState(globalAlbumAware);
  const initialAlbumAware = useRef(globalAlbumAware);
  useEffect(() => setIsAlbumAware(globalAlbumAware), [globalAlbumAware]);
  const initialShuffleMode = useRef(globalShuffleMode);
  useEffect(() => setShuffleMode(globalShuffleMode), [globalShuffleMode]);
  const [streamQuality, setStreamQuality] = useState(globalStreamQuality);
  const [downloadQuality, setDownloadQuality] = useState(globalDownloadQuality);
  const [isReplayGainEnabled, setIsReplayGainEnabled] = useState(
    globalReplayGainEnabled,
  );
  const [layoutDensity, setLayoutDensity] = useState(globalLayoutDensity);
  const [normalizationTarget, setNormalizationTarget] = useState(globalNormalizationTarget);
  const [theme, setTheme] = useState(getActiveTheme);
  const [themeError, setThemeError] = useState(null);
  const themeTouchedRef = useRef(false);
  const [layoutPreset, setLayoutPreset] = useState(getActiveLayoutPreset);
  const [layoutPresetError, setLayoutPresetError] = useState(null);
  const layoutPresetTouchedRef = useRef(false);
  const [accentColor, setAccentColor] = useState(globalAccentColor);
  const [autoOpenSidebar, setAutoOpenSidebar] = useState(globalAutoOpenSidebar);
  const [isAutoplayEnabled, setIsAutoplayEnabled] = useState(globalAutoplayEnabled);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeMessage, setReanalyzeMessage] = useState("");
  const [cacheMessage, setCacheMessage] = useState("");
  const initialCrossfadePreference = useRef({
    duration: globalCrossfadeDuration,
    change: changeCrossfadeDuration,
    mode: globalTransitionMode,
    changeMode: changeTransitionMode,
  });
  const initialAudioPreferences = useRef({
    streamQuality: globalStreamQuality,
    changeStreamQuality,
    downloadQuality: globalDownloadQuality,
    changeDownloadQuality,
    replayGainEnabled: globalReplayGainEnabled,
    changeReplayGainEnabled,
    normalizationTarget: globalNormalizationTarget,
    changeNormalizationTarget,
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

          const savedCrossfadeDuration = Number(
            getSetting(settings, "playback.crossfadeDuration", Number.NaN),
          );
          const savedTransitionMode = getSetting(settings, "playback.transitionMode", null);
          const hasSavedCrossfade = Number.isFinite(savedCrossfadeDuration) && savedCrossfadeDuration > 0;
          const nextCrossfadeDuration = hasSavedCrossfade
            ? clampCrossfadeDuration(savedCrossfadeDuration)
            : clampCrossfadeDuration(initialCrossfadePreference.current.duration);
          // Accounts saved before transition modes existed used a positive duration to mean crossfade.
          const nextTransitionMode = isTransitionMode(savedTransitionMode)
            ? savedTransitionMode
            : hasSavedCrossfade
              ? "crossfade"
              : initialCrossfadePreference.current.mode;

          setCrossfadeDuration(nextCrossfadeDuration);
          setTransitionMode(nextTransitionMode);
          const storedShuffleMode = getSetting(settings, "playback.shuffleMode", initialShuffleMode.current);
          setShuffleMode(isShuffleMode(storedShuffleMode) ? storedShuffleMode : "standard");
          setIsAlbumAware(getSetting(settings, "playback.albumAware", initialAlbumAware.current) === true);
          if (hasSavedCrossfade) initialCrossfadePreference.current.change?.(nextCrossfadeDuration);
          initialCrossfadePreference.current.changeMode?.(nextTransitionMode);

          const nextStreamQuality = ["128", "256", "320", "original", "direct"].includes(
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
              "playback.normalization.enabled",
              initialAudioPreferences.current.replayGainEnabled,
            ),
          );

          setIsReplayGainEnabled(nextReplayGainEnabled);
          const storedTarget = getSetting(settings, "playback.normalization.targetLufs", initialAudioPreferences.current.normalizationTarget);
          const target = LOUDNESS_TARGETS.includes(storedTarget) ? storedTarget : DEFAULT_LOUDNESS_TARGET;
          setNormalizationTarget(target);
          initialAudioPreferences.current.changeNormalizationTarget?.(target);
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

          const savedTheme = normalizeTheme(getSetting(settings, THEME_SETTING_KEY, null));
          if (savedTheme && !themeTouchedRef.current) setTheme(savedTheme);

          const savedLayoutPreset = normalizeLayoutPreset(getSetting(settings, LAYOUT_PRESET_SETTING_KEY, null));
          if (savedLayoutPreset && !layoutPresetTouchedRef.current) setLayoutPreset(savedLayoutPreset);

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
        "playback.transitionMode": transitionMode,
        "playback.shuffleMode": shuffleMode,
        "playback.albumAware": isAlbumAware,
        "playback.streamQuality": streamQuality,
        "playback.downloadQuality": downloadQuality,
        "playback.normalization.enabled": isReplayGainEnabled,
        "playback.normalization.targetLufs": normalizationTarget,
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

  function storeLocally(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // The server save remains available if browser storage is blocked.
    }
  }

  function handleCrossfadeChange(nextDuration) {
    setCrossfadeDuration(nextDuration);
    if (changeCrossfadeDuration) changeCrossfadeDuration(nextDuration);
    else storeLocally("playerCrossfadeDuration", String(nextDuration));
  }

  function handleTransitionModeChange(nextMode) {
    setTransitionMode(nextMode);
    if (changeTransitionMode) changeTransitionMode(nextMode);
    else storeLocally("playerTransitionMode", nextMode);
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
        localStorage.setItem("playerNormalizationEnabled", String(nextEnabled));
      } catch {
        // Saving to the backend remains available if browser storage is blocked.
      }
    }
  }

  useEffect(() => {
    function handleUserSettingsChanged(event) {
      if (typeof event.detail?.["playback.albumAware"] === "boolean") setIsAlbumAware(event.detail["playback.albumAware"]);
      const nextShuffleMode = event.detail?.["playback.shuffleMode"];
      if (isShuffleMode(nextShuffleMode)) setShuffleMode(nextShuffleMode);
      const nextTheme = normalizeTheme(event.detail?.[THEME_SETTING_KEY]);
      if (nextTheme) setTheme(nextTheme);
      const nextLayoutPreset = normalizeLayoutPreset(event.detail?.[LAYOUT_PRESET_SETTING_KEY]);
      if (nextLayoutPreset) setLayoutPreset(nextLayoutPreset);
    }

    window.addEventListener(USER_SETTINGS_CHANGED_EVENT, handleUserSettingsChanged);
    return () => window.removeEventListener(USER_SETTINGS_CHANGED_EVENT, handleUserSettingsChanged);
  }, []);

  async function handleThemeChange(nextTheme) {
    if (nextTheme === theme) return;
    themeTouchedRef.current = true;
    setThemeError(null);
    try {
      await saveThemePreference(nextTheme);
    } catch (err) {
      setThemeError(err.message || "Could not save theme.");
    }
  }

  async function handleLayoutPresetChange(nextPreset) {
    if (nextPreset === layoutPreset) return;
    layoutPresetTouchedRef.current = true;
    setLayoutPresetError(null);
    try {
      await saveLayoutPresetPreference(nextPreset);
    } catch (err) {
      setLayoutPresetError(err.message || "Could not save layout style.");
    }
  }

  function handleLayoutPresetKeyDown(event) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const currentIndex = Math.max(0, LAYOUT_PRESET_OPTIONS.findIndex((option) => option.value === layoutPreset));
    const next = LAYOUT_PRESET_OPTIONS[(currentIndex + step + LAYOUT_PRESET_OPTIONS.length) % LAYOUT_PRESET_OPTIONS.length];
    handleLayoutPresetChange(next.value);
    event.currentTarget.querySelector(`[data-layout-preset-option="${next.value}"]`)?.focus();
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
      const analysis = await analyzeSilence(currentSong.id, {
        thresholdDb: Number(silenceThresholdDb),
        minSilenceSeconds: Number(silenceMinSeconds),
      });
      setReanalyzeMessage(analysis?.status === "completed" ? "Re-analysis complete for the current track." : "Could not analyze this track. Please try again.");
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

          {player.audioEngine && <Suspense fallback={<p role="status">Loading equalizer…</p>}>
            <EqualizerSettings engine={player.audioEngine} local={!player.isCasting && !player.isRemotePlayback} />
          </Suspense>}

          <article className="settings-row settings-row-featured">
            <div className="settings-row-copy">
              <h3>Automatic Silence Trimming</h3>
              <p>
                Automatically analyze new library tracks during playback, then
                skip detected silence at the beginning and end.
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
                min="-100"
                max="0"
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
                min="0.1"
                max="30"
                step="0.1"
                value={silenceMinSeconds}
                onChange={(event) => setSilenceMinSeconds(event.target.value)}
                disabled={!silenceTrimEnabled}
              />
            </label>
          </div>

          <SilenceScanControl disabled={!silenceTrimEnabled} thresholdDb={silenceThresholdDb} minSilenceSeconds={silenceMinSeconds}>
            <button
              type="button"
              className="account-secondary"
              onClick={handleReanalyze}
              disabled={!silenceTrimEnabled || !currentSong || reanalyzing}
            >
              {reanalyzing ? "Analyzing..." : "Re-analyze current track"}
            </button>
          </SilenceScanControl>
          {reanalyzeMessage && (
            <span className="settings-inline-message">{reanalyzeMessage}</span>
          )}

          <PlayerSettings
            isAlbumAware={isAlbumAware}
            onAlbumAwareChange={(enabled) => {
              setIsAlbumAware(enabled);
              if (changeAlbumAware) changeAlbumAware(enabled);
              else storeLocally("playerAlbumAware", String(enabled));
            }}
            shuffleMode={shuffleMode}
            onShuffleModeChange={(mode) => {
              setShuffleMode(mode);
              if (changeShuffleMode) changeShuffleMode(mode);
              else storeLocally("playerShuffleMode", mode);
            }}
            transitionMode={transitionMode}
            crossfadeDuration={crossfadeDuration}
            onTransitionModeChange={handleTransitionModeChange}
            onCrossfadeDurationChange={handleCrossfadeChange}
          />

          <article className="settings-row">
            <div className="settings-row-copy">
              <h3>Streaming Quality</h3>
              <p>Choose the maximum bitrate used when your music server transcodes.</p>
            </div>
            <label className="settings-select-control">
              <span>Streaming quality</span>
              <select value={streamQuality} onChange={handleStreamQualityChange}>
                <option value="128">128 kbps</option>
                <option value="256">256 kbps</option>
                <option value="320">320 kbps</option>
                <option value="direct">Direct passthrough (no server normalization)</option>
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
              <h3>Volume Normalization</h3>
              <p>Songs start immediately. Volume adjusts smoothly as tracks are measured, and upcoming songs prepare in the background. Your original files stay unchanged.</p>
            </div>
            <label
              className="settings-switch"
              aria-label="Volume Normalization"
            >
              <input
                type="checkbox"
                checked={isReplayGainEnabled}
                onChange={handleReplayGainChange}
              />
              <span aria-hidden="true" />
            </label>
          </article>
          <div className={`settings-normalization-options${!isReplayGainEnabled ? " is-disabled" : ""}`}
            role="group" aria-label="Volume normalization options" aria-disabled={!isReplayGainEnabled}
            aria-describedby={!isReplayGainEnabled ? "normalization-options-hint" : undefined}>
            {!isReplayGainEnabled && <p id="normalization-options-hint" className="settings-normalization-hint">Enable Volume Normalization to change the loudness target or scan your library.</p>}
            <article className="settings-row settings-normalization-target">
              <div className="settings-row-copy">
                <h3>Loudness target</h3>
                <p>Applies only to your account. Peak protection stays on, so very dynamic songs may play a little quieter.</p>
              </div>
              <label className="settings-select-control">
                <span>Loudness target</span>
                <select value={normalizationTarget} disabled={!isReplayGainEnabled} onChange={event => {
                  const target = Number(event.target.value);
                  setNormalizationTarget(target);
                  changeNormalizationTarget?.(target);
                }}>
                  <option value={-18}>−18 LUFS · More headroom</option>
                  <option value={-16}>−16 LUFS · Balanced</option>
                  <option value={-14}>−14 LUFS · Louder</option>
                </select>
              </label>
            </article>
            <LoudnessScanControl disabled={!isReplayGainEnabled} />
          </div>
        </section>

        <section className="settings-section" aria-labelledby="interface-layout-title">
          <div className="settings-section-heading">
            <span>02</span>
            <h2 id="interface-layout-title">Interface &amp; Layout</h2>
          </div>

          <article className="settings-row settings-theme-row">
            <div className="settings-row-copy">
              <h3>Theme</h3>
              <p>Switch between dark and light appearance. Applies instantly and syncs to your account.</p>
              {themeError && <p className="settings-inline-error" role="alert">{themeError}</p>}
            </div>
            <div
              className="settings-density-control"
              role="radiogroup"
              aria-label="Theme"
            >
              <span
                className={`settings-density-indicator${theme === "light" ? " is-second" : ""}`}
                aria-hidden="true"
              />
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.value}
                  className={theme === option.value ? "active" : ""}
                  onClick={() => handleThemeChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </article>

          <article className="settings-row settings-layout-preset-row">
            <div className="settings-row-copy">
              <h3>Layout Style</h3>
              <p>
                Choose the app structure you feel at home in. Switching is instant, keeps your music playing, and syncs to your account.
                Below 768px every style uses the same mobile layout.
              </p>
              {layoutPresetError && <p className="settings-inline-error" role="alert">{layoutPresetError}</p>}
            </div>
            <div
              className="layout-preset-picker"
              role="radiogroup"
              aria-label="Layout Style"
              onKeyDown={handleLayoutPresetKeyDown}
            >
              {LAYOUT_PRESET_OPTIONS.map((option) => {
                const isSelected = layoutPreset === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={option.label}
                    aria-describedby={`layout-preset-${option.value}-description`}
                    tabIndex={isSelected ? 0 : -1}
                    data-layout-preset-option={option.value}
                    className={`layout-preset-card${isSelected ? " active" : ""}`}
                    onClick={() => handleLayoutPresetChange(option.value)}
                  >
                    <span className={`layout-preset-diagram layout-preset-diagram--${option.value}`} aria-hidden="true">
                      <span className="lpd-header" />
                      <span className="lpd-nav" />
                      <span className="lpd-main"><i /><i /><i /></span>
                      <span className="lpd-aside" />
                      <span className="lpd-player" />
                    </span>
                    <span className="layout-preset-card-copy">
                      <span className="layout-preset-card-label">{option.label}</span>
                      <span className="layout-preset-card-subtitle">{option.subtitle}</span>
                      <span className="layout-preset-card-description" id={`layout-preset-${option.value}-description`}>
                        {option.description}
                      </span>
                    </span>
                    <span className="layout-preset-card-check" aria-hidden="true">✓</span>
                  </button>
                );
              })}
            </div>
          </article>

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

        <OfflineStoragePanel />
        <DataExportPanel />

        <div className="settings-submit-row">
          {message && <span className="success">{message}</span>}
          <button type="submit" className="account-primary" disabled={saving}>
            {saving ? "Saving..." : "Save settings"}
          </button>
        </div>
      </form>
      <TasteProfileView embedded />
    </div>
  );
}

export default Settings;
