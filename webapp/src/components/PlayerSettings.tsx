import { useId } from "react";
import type { ChangeEvent, CSSProperties } from "react";

import {
  CROSSFADE_MAX_SECONDS,
  CROSSFADE_MIN_SECONDS,
  clampCrossfadeDuration,
  isTransitionMode,
} from "../context/PlayerContext";
import type { TransitionMode } from "../context/PlayerContext";
import { isShuffleMode } from "../utils/shuffle";
import type { ShuffleMode } from "../utils/shuffle";

interface TransitionOption {
  value: TransitionMode;
  label: string;
  description: string;
}

const TRANSITION_OPTIONS: readonly TransitionOption[] = [
  {
    value: "none",
    label: "Off",
    description: "Each track starts after the previous one finishes, with no overlap.",
  },
  {
    value: "gapless",
    label: "Gapless",
    description: "Albums flow without silence between tracks, so live and concept records stay seamless.",
  },
  {
    value: "crossfade",
    label: "Crossfade",
    description: "Blend the end of one track into the beginning of the next.",
  },
];

export interface PlayerSettingsProps {
  transitionMode: TransitionMode;
  /** Seconds, 1–10. Kept while another mode is selected so switching back restores it. */
  crossfadeDuration: number;
  onTransitionModeChange: (mode: TransitionMode) => void;
  onCrossfadeDurationChange: (seconds: number) => void;
  shuffleMode?: ShuffleMode;
  onShuffleModeChange?: (mode: ShuffleMode) => void;
  isAlbumAware?: boolean;
  onAlbumAwareChange?: (enabled: boolean) => void;
}

/**
 * Track transition preferences. Controlled: the player applies changes to the
 * playback engine immediately, so the next transition already uses them.
 */
function PlayerSettings({
  transitionMode,
  crossfadeDuration,
  onTransitionModeChange,
  onCrossfadeDurationChange,
  shuffleMode = "standard",
  onShuffleModeChange,
  isAlbumAware = false,
  onAlbumAwareChange,
}: PlayerSettingsProps) {
  const id = useId();
  const groupName = `${id}-transition-mode`;
  const descriptionId = `${id}-transition-description`;
  const sliderId = `${id}-crossfade-duration`;
  const sliderHintId = `${id}-crossfade-hint`;
  const isCrossfade = transitionMode === "crossfade";
  const seconds = clampCrossfadeDuration(crossfadeDuration);
  const selected = TRANSITION_OPTIONS.find((option) => option.value === transitionMode) ?? TRANSITION_OPTIONS[1];
  const progress = ((seconds - CROSSFADE_MIN_SECONDS) / (CROSSFADE_MAX_SECONDS - CROSSFADE_MIN_SECONDS)) * 100;

  function handleModeChange(event: ChangeEvent<HTMLInputElement>) {
    if (isTransitionMode(event.target.value)) onTransitionModeChange(event.target.value);
  }

  function handleDurationChange(event: ChangeEvent<HTMLInputElement>) {
    onCrossfadeDurationChange(clampCrossfadeDuration(Number(event.target.value)));
  }

  return (
    <>
      <article className="settings-row">
        <div className="settings-row-copy">
          <h3>Album-Aware Playback</h3>
          <p id={`${id}-album-hint`}>For ordered album playback, use Album ReplayGain, preserve recorded pauses, and prefer gapless transitions. Shuffle and other queues use your usual settings. Missing album gain leaves the original dynamics unchanged.</p>
        </div>
        <label className="settings-switch">
          <input type="checkbox" checked={isAlbumAware} disabled={!onAlbumAwareChange}
            aria-label="Album-aware playback"
            aria-describedby={`${id}-album-hint`} onChange={(event) => onAlbumAwareChange?.(event.target.checked)} />
          <span aria-hidden="true" />
        </label>
      </article>

      <article className="settings-row settings-transition-row">
        <div className="settings-row-copy">
          <h3>Shuffle Mode</h3>
          <p id={`${id}-shuffle-hint`}>Smart Shuffle avoids tracks heard in the last two hours, favors liked songs, and reduces artist clustering. It keeps the current track and past queue order. Enable shuffle in the player to use it.</p>
        </div>
        <fieldset className="settings-transition-control settings-shuffle-control" aria-describedby={`${id}-shuffle-hint`} disabled={!onShuffleModeChange}>
          <legend>Shuffle mode</legend>
          {(["standard", "smart"] as const).map((mode) => <label key={mode} className={shuffleMode === mode ? "active" : undefined}>
            <input type="radio" name={`${id}-shuffle-mode`} value={mode} checked={shuffleMode === mode}
              onChange={(event) => { if (isShuffleMode(event.target.value)) onShuffleModeChange?.(event.target.value); }} />
            <span>{mode === "smart" ? "Smart Shuffle" : "Standard Shuffle"}</span>
          </label>)}
        </fieldset>
      </article>

      <article className="settings-row settings-transition-row">
        <div className="settings-row-copy">
          <h3>Track Transitions</h3>
          <p id={descriptionId} aria-live="polite">{selected.description}</p>
        </div>
        <fieldset className="settings-transition-control" aria-describedby={descriptionId}>
          <legend>Track transitions</legend>
          {TRANSITION_OPTIONS.map((option) => {
            const checked = option.value === selected.value;
            return (
              <label key={option.value} className={checked ? "active" : undefined}>
                <input
                  type="radio"
                  name={groupName}
                  value={option.value}
                  checked={checked}
                  onChange={handleModeChange}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </fieldset>
      </article>

      <article className={`settings-row settings-crossfade-row${isCrossfade ? "" : " is-disabled"}`}>
        <div className="settings-row-copy">
          <h3>Crossfade</h3>
          <p id={sliderHintId}>
            {isCrossfade
              ? "How long the outgoing and incoming tracks overlap."
              : "Select Crossfade above to adjust the blend length."}
          </p>
        </div>

        <div className="settings-range-control">
          <label htmlFor={sliderId}>Crossfade duration</label>
          <input
            id={sliderId}
            type="range"
            min={CROSSFADE_MIN_SECONDS}
            max={CROSSFADE_MAX_SECONDS}
            step="1"
            value={seconds}
            disabled={!isCrossfade}
            aria-describedby={sliderHintId}
            aria-valuetext={`${seconds} seconds`}
            onChange={handleDurationChange}
            style={{ "--range-progress": `${progress}%` } as CSSProperties}
          />
          <output htmlFor={sliderId}>{seconds} s</output>
        </div>
      </article>
    </>
  );
}

export default PlayerSettings;
