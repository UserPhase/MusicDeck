export const SLEEP_MINUTES = [15, 30, 45, 60] as const;
export type SleepMinutes = typeof SLEEP_MINUTES[number];
export const SLEEP_FADE_SECONDS = 5;

type Plan = { mode: "duration"; deadline: number } |
  { mode: "track" | "album"; keys: readonly string[]; target: string };
type Snapshot = {
  mode: Plan["mode"] | null;
  status: "off" | "armed" | "fading" | "stopped";
  deadline: number | null;
};
export const SLEEP_OFF: Snapshot = { mode: null, status: "off", deadline: null };

export class SleepTimerService {
  private plan: Plan | null = null;
  private state = SLEEP_OFF;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private fadeDeadline: number | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly output: {
    fade(delaySeconds: number, durationSeconds: number): void;
    restore(): void;
    stop(): void;
    now?(): number;
  }) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  armDuration(minutes: SleepMinutes): void {
    if (!SLEEP_MINUTES.includes(minutes)) throw new Error("Unsupported sleep timer duration.");
    this.cancel();
    const deadline = this.now() + minutes * 60_000;
    this.plan = { mode: "duration", deadline };
    this.publish("armed", deadline);
    this.scheduleFade(deadline);
    this.checkDeadline();
  }

  armBoundary(mode: "track" | "album", keys: readonly string[]): void {
    if (!keys.length || (mode === "track" && keys.length !== 1)) throw new Error("No active playback boundary.");
    this.cancel();
    this.plan = { mode, keys: [...keys], target: keys[keys.length - 1] };
    this.publish("armed");
  }

  blocksTransition(key: string | null): boolean {
    return Boolean(this.plan && this.plan.mode !== "duration" && this.plan.target === key);
  }

  validateAlbum(remainingKeys: readonly string[]): void {
    const plan = this.plan;
    if (plan?.mode !== "album") return;
    const start = plan.keys.indexOf(remainingKeys[0]);
    if (start < 0 || plan.keys.length - start !== remainingKeys.length ||
      remainingKeys.some((key, index) => key !== plan.keys[start + index])) {
      this.cancel();
    }
  }

  updateBoundary(key: string, remainingSeconds: number | null, playing: boolean): void {
    if (!this.plan || this.plan.mode === "duration") return;
    if (!this.plan.keys.includes(key)) {
      this.cancel();
      return;
    }
    if (key !== this.plan.target || !playing || remainingSeconds === null) {
      this.resetBoundaryFade();
      return;
    }
    const deadline = this.now() + remainingSeconds * 1000;
    if (this.fadeDeadline === null || Math.abs(deadline - this.fadeDeadline) > 350) {
      this.scheduleFade(deadline);
    }
    this.publish(remainingSeconds <= SLEEP_FADE_SECONDS ? "fading" : "armed");
  }

  resetBoundaryFade(): void {
    if (!this.plan || this.plan.mode === "duration" || this.fadeDeadline === null) return;
    this.fadeDeadline = null;
    this.output.restore();
    this.publish("armed");
  }

  endBoundary(key: string): boolean {
    if (!this.blocksTransition(key)) return false;
    this.finish();
    return true;
  }

  /** Reconcile wall time after background throttling or an audio context suspension. */
  checkDeadline = (): void => {
    clearTimeout(this.timeout);
    if (this.plan?.mode !== "duration") return;
    const remaining = this.plan.deadline - this.now();
    if (remaining <= 0) {
      this.finish();
      return;
    }
    const fading = remaining <= SLEEP_FADE_SECONDS * 1000;
    this.publish(fading ? "fading" : "armed", this.plan.deadline);
    this.timeout = setTimeout(this.checkDeadline, fading ? remaining : remaining - SLEEP_FADE_SECONDS * 1000);
  };

  realignClock(): void {
    if (this.plan?.mode === "duration" && this.plan.deadline > this.now()) this.scheduleFade(this.plan.deadline);
    this.checkDeadline();
  }

  cancel(): void {
    const active = this.plan !== null;
    this.clear();
    if (active) this.output.restore();
    this.publish("off");
  }

  dispose(): void {
    this.listeners.clear();
    this.cancel();
  }

  private now() { return this.output.now?.() ?? Date.now(); }

  private scheduleFade(deadline: number): void {
    this.fadeDeadline = deadline;
    const remaining = Math.max(0, (deadline - this.now()) / 1000);
    const duration = Math.min(SLEEP_FADE_SECONDS, remaining);
    this.output.fade(remaining - duration, duration);
  }

  private clear() {
    clearTimeout(this.timeout);
    this.timeout = undefined;
    this.plan = null;
    this.fadeDeadline = null;
  }

  private finish() {
    const mode = this.plan?.mode ?? null;
    this.clear();
    this.output.stop();
    this.output.restore();
    this.state = { mode, status: "stopped", deadline: null };
    this.listeners.forEach(listener => listener());
  }

  private publish(status: Snapshot["status"], deadline: number | null = null) {
    const mode = this.plan?.mode ?? null;
    if (this.state.status === status && this.state.mode === mode && this.state.deadline === deadline) return;
    this.state = { mode, status, deadline };
    this.listeners.forEach(listener => listener());
  }
}
