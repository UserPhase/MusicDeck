import type { MediaDeck } from "./outputs";

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
}

const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
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
 * Browsers do not let scripts add headers to media element requests. Reloading
 * the same URL and seeking to the saved timestamp makes the browser issue the
 * `Range: bytes=<offset>-` request itself, using its demuxer index to map the
 * timestamp to the correct byte offset (which scripts cannot do for VBR/containers).
 */
export class MediaStallRecovery {
  private deck: MediaDeck | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private watchdogPosition = 0;
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
    if (this.watchdog === null || !this.deck) return;
    if (hasProgressed(this.deck.element, this.watchdogPosition)) this.clearWatchdog();
  }

  /** Returns true when the error is a recoverable network failure. */
  notifyError(): boolean {
    const deck = this.deck;
    if (!deck || !deck.isLoaded()) return false;
    // A failed run stays failed until the user retries; it must not restart on its own.
    if (this.run) return true;
    const code = deck.element.error?.code;
    const midStream = deck.position() > 0;
    if (code !== MEDIA_ERR_NETWORK && !(code === MEDIA_ERR_SRC_NOT_SUPPORTED && midStream)) {
      return false;
    }
    this.begin();
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

  private begin(): void {
    const deck = this.deck;
    if (!deck) return;
    this.clearWatchdog();
    const run: RecoveryRun = {
      key: deck.key,
      position: deck.position(),
      attempt: 0,
      failed: false,
      timer: null,
      detach: null,
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

    const detach = () => {
      element.removeEventListener("loadedmetadata", onMetadata);
      element.removeEventListener("error", onError);
      if (run.timer !== null) clearTimeout(run.timer);
      run.timer = null;
      run.detach = null;
    };
    const onError = () => {
      detach();
      this.scheduleAttempt(run);
    };
    const onMetadata = () => {
      detach();
      if (this.run !== run) return;
      const seekable = deck.isSeekable();
      const duration = deck.duration();
      const target = seekable && Number.isFinite(duration)
        ? Math.min(run.position, Math.max(0, duration - END_GUARD_SECONDS))
        : 0;
      if (target > 0) deck.seek(target);
      const restarted = !seekable && run.position > 0;
      if (!this.host.wantsPlayback()) {
        this.succeed(run, restarted, target);
        return;
      }
      deck.play().then(
        () => this.succeed(run, restarted, target),
        () => {
          if (!this.host.wantsPlayback()) this.succeed(run, restarted, target);
          else this.scheduleAttempt(run);
        }
      );
    };

    element.addEventListener("loadedmetadata", onMetadata);
    element.addEventListener("error", onError);
    run.detach = detach;
    run.timer = setTimeout(() => {
      detach();
      this.scheduleAttempt(run);
    }, this.options.loadTimeoutMs);
    deck.reloadSource(source ?? undefined);
  }

  private succeed(run: RecoveryRun, restartedFromBeginning: boolean, position: number): void {
    if (this.run !== run) return;
    this.run = null;
    this.host.onRecovered({
      key: run.key,
      position,
      attempts: run.attempt,
      restartedFromBeginning,
    });
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
