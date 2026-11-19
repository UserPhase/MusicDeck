import type { MediaDeck } from "./outputs";
import { replacementPlaybackUrl } from "../../utils/streamRecovery";

export interface StallRecoveryOptions {
  stallTimeoutMs: number;
  loadTimeoutMs: number;
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
}

export interface StallRecoveryHost {
  wantsPlayback(): boolean;
  recoverySource?(key: string): string | null | Promise<string | null>;
  onStall(info: { key: string; position: number; attempt: number; maxAttempts: number }): void;
  onRecovered(info: {
    key: string;
    position: number;
    attempts: number;
    restartedFromBeginning: boolean;
    streamUrl?: string;
  }): void;
  onFailed(info: { key: string; position: number; attempts: number }): void;
}

interface RecoveryRun {
  readonly key: string;
  position: number;
  attempt: number;
  failed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  detach: (() => void) | null;
  replacementUrl: string | null;
}

const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
const HAVE_FUTURE_DATA = 3;
const PROGRESS_EPSILON_SECONDS = 0.25;
const END_GUARD_SECONDS = 0.25;

function hasProgressed(element: HTMLMediaElement, since: number): boolean {
  return element.readyState >= HAVE_FUTURE_DATA &&
    element.currentTime > since + PROGRESS_EPSILON_SECONDS;
}

/**
 * Watches the active HTMLMediaElement for mid-stream stalls and reconnects it
 * without touching queue state.
 *
 * The first reload uses the pinned URL. Later attempts can obtain a fresh
 * representation, with the browser resolving the seek using its new metadata.
 */
export class MediaStallRecovery {
  private deck: MediaDeck | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private watchdogPosition = 0;
  private lastPosition = 0;
  private run: RecoveryRun | null = null;

  constructor(
    private readonly host: StallRecoveryHost,
    private readonly options: StallRecoveryOptions
  ) {}

  watch(deck: MediaDeck | null): void {
    if (deck === this.deck) return;
    this.cancel();
    this.deck = deck;
  }

  isRecovering(): boolean {
    return this.run !== null && !this.run.failed;
  }

  hasFailed(): boolean {
    return this.run?.failed === true;
  }

  savedPosition(): number | null {
    return this.run ? this.run.position : null;
  }

  /** `waiting` / `stalled`: arm the 3.5 s watchdog if the user expects audio. */
  notifyWaiting(): void {
    const deck = this.deck;
    if (!deck || !deck.isLoaded() || this.run || this.watchdog !== null) return;
    if (!this.host.wantsPlayback()) return;
    this.watchdogPosition = deck.position();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.deck !== deck || this.run || !deck.isLoaded()) return;
      if (hasProgressed(deck.element, this.watchdogPosition)) return;
      if (!this.host.wantsPlayback()) return;
      this.begin();
    }, this.options.stallTimeoutMs);
  }

  /** `timeupdate`: a recovered stream disarms the watchdog. */
  notifyProgress(): void {
    if (!this.deck || this.run) return;
    this.lastPosition = this.deck.position();
    if (this.watchdog === null) return;
    if (hasProgressed(this.deck.element, this.watchdogPosition)) this.clearWatchdog();
  }

  /** Browsers may report an HTTP failure as an unsupported source. */
  notifyError(code: number | undefined, retryAtStart: boolean, startAt?: number): boolean {
    const deck = this.deck;
    if (!deck || !deck.isLoaded()) return false;
    // A failed run stays failed until the user retries; it must not restart on its own.
    if (this.run) return true;
    const interruptedDecode = code === MEDIA_ERR_DECODE && this.lastPosition > 0;
    if (code !== MEDIA_ERR_NETWORK && !interruptedDecode &&
      !(code === MEDIA_ERR_SRC_NOT_SUPPORTED && (deck.position() > 0 || this.lastPosition > 0 || retryAtStart))) {
      return false;
    }
    this.begin(startAt);
    return true;
  }

  /** Seeks requested while reconnecting are applied once the stream reloads. */
  updatePosition(seconds: number): void {
    if (this.run) this.run.position = Math.max(0, seconds);
  }

  /** Manual retry after all automatic attempts failed (e.g. the user pressed play). */
  retryNow(): boolean {
    const run = this.run;
    if (!run || !run.failed) return false;
    run.failed = false;
    run.attempt = 0;
    this.scheduleAttempt(run);
    return true;
  }

  cancel(): void {
    this.clearWatchdog();
    this.lastPosition = 0;
    const run = this.run;
    this.run = null;
    if (!run) return;
    run.detach?.();
    if (run.timer !== null) clearTimeout(run.timer);
  }

  dispose(): void {
    this.cancel();
    this.deck = null;
  }

  private begin(startAt?: number): void {
    const deck = this.deck;
    if (!deck) return;
    this.clearWatchdog();
    const run: RecoveryRun = {
      key: deck.key,
      position: startAt ?? (deck.position() || this.lastPosition),
      attempt: 0,
      failed: false,
      timer: null,
      detach: null,
      replacementUrl: null,
    };
    this.run = run;
    this.scheduleAttempt(run);
  }

  private scheduleAttempt(run: RecoveryRun): void {
    if (this.run !== run) return;
    run.detach?.();
    run.detach = null;
    run.attempt += 1;
    if (run.attempt > this.options.maxAttempts) {
      run.attempt = this.options.maxAttempts;
      run.failed = true;
      this.deck?.pause();
      this.host.onFailed({ key: run.key, position: run.position, attempts: run.attempt });
      return;
    }
    this.host.onStall({
      key: run.key,
      position: run.position,
      attempt: run.attempt,
      maxAttempts: this.options.maxAttempts,
    });
    const delay = this.options.backoffMs(run.attempt);
    if (delay <= 0) {
      this.reload(run);
      return;
    }
    run.timer = setTimeout(() => {
      run.timer = null;
      this.reload(run);
    }, delay);
  }

  private reload(run: RecoveryRun): void {
    const source = this.host.recoverySource?.(run.key);
    if (source && typeof source !== "string") {
      void source.then(
        local => this.reloadResolved(run, local),
        () => this.reloadResolved(run, null)
      );
      return;
    }
    this.reloadResolved(run, source ?? null);
  }

  private reloadResolved(run: RecoveryRun, source: string | null): void {
    const deck = this.deck;
    if (this.run !== run || !deck || deck.key !== run.key) return;
    const element = deck.element;
    const replacement = source === null && run.attempt > 1 ? replacementPlaybackUrl(deck.src) : null;
    if (replacement) run.replacementUrl = replacement;
    let restoring = false;
    let seekTargetRequested = 0;

    const detach = () => {
      element.removeEventListener("loadedmetadata", onReady);
      element.removeEventListener("progress", onReady);
      element.removeEventListener("canplay", onReady);
      element.removeEventListener("error", onError);
      element.removeEventListener("seeked", onSeeked);
      if (run.timer !== null) clearTimeout(run.timer);
      run.timer = null;
      run.detach = null;
    };
    const onError = () => this.scheduleAttempt(run);
    const onSeeked = () => {
      if (element.seeking || run.detach !== detach) return;
      const target = seekTarget();
      if (target !== seekTargetRequested && deck.isSeekable()) {
        seekTargetRequested = target;
        deck.seek(target);
        if (element.seeking) return;
      }
      element.removeEventListener("seeked", onSeeked);
      restorePlayback();
    };
    const seekTarget = () => {
      const duration = deck.duration();
      return deck.isSeekable() && Number.isFinite(duration)
        ? Math.min(run.position, Math.max(0, duration - END_GUARD_SECONDS)) : 0;
    };
    const restorePlayback = () => {
      const finish = () => {
        if (run.detach !== detach) return;
        if (!this.host.wantsPlayback() && deck.isPlaying()) deck.pause();
        const settledPosition = seekTarget();
        if (deck.isSeekable() && settledPosition !== seekTargetRequested) deck.seek(settledPosition);
        detach();
        this.succeed(run, !deck.isSeekable() && run.position > 0, settledPosition);
      };
      if (!this.host.wantsPlayback()) {
        finish();
        return;
      }
      deck.play().then(
        finish,
        () => {
          if (run.detach !== detach) return;
          if (!this.host.wantsPlayback()) finish();
          else this.scheduleAttempt(run);
        }
      );
    };
    const onReady = (event: Event) => {
      if (restoring || run.detach !== detach || element.readyState < 1) return;
      const seekable = deck.isSeekable();
      // A finite stream can expose metadata before its first seekable range.
      if (run.position > 0 && !seekable && Number.isFinite(element.duration) && event.type !== "canplay") return;
      restoring = true;
      seekTargetRequested = seekTarget();
      if (seekTargetRequested > 0) deck.seek(seekTargetRequested);
      if (replacement && element.seeking) {
        element.addEventListener("seeked", onSeeked);
        return;
      }
      restorePlayback();
    };

    element.addEventListener("loadedmetadata", onReady);
    element.addEventListener("progress", onReady);
    element.addEventListener("canplay", onReady);
    element.addEventListener("error", onError);
    run.detach = detach;
    run.timer = setTimeout(() => {
      detach();
      this.scheduleAttempt(run);
    }, this.options.loadTimeoutMs);
    deck.reloadSource(source ?? replacement ?? undefined);
  }

  private succeed(run: RecoveryRun, restartedFromBeginning: boolean, position: number): void {
    if (this.run !== run) return;
    this.run = null;
    this.lastPosition = position;
    this.host.onRecovered({
      key: run.key,
      position,
      attempts: run.attempt,
      restartedFromBeginning,
      ...(run.replacementUrl && this.deck?.src === run.replacementUrl ? { streamUrl: run.replacementUrl } : {}),
    });
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
