// Compiled into the acceptance build only. The production application has no test API.
import { useEffect } from "react";
import { usePlayer } from "../../../webapp/src/context/PlayerContext";
import { offlineDownloadEngine } from "../../../webapp/src/services/storage/OfflineDownloadEngine";
import { createQueueState, queueReducer, queueInvariantViolations } from "../../../webapp/src/hooks/useQueueStore";
import type { PlaybackEngine } from "../../../webapp/src/services/audio/PlaybackEngine";
import { readLocalQueue, writeLocalQueue, clearLocalQueue, sanitizeQueueTrack } from "../../../webapp/src/services/storage/QueueDatabase";
import { queueSyncClient } from "../../../webapp/src/services/QueueSyncClient";
import { cleanParametricBands, EqualizerEngine } from "../../../webapp/src/services/audio/EqualizerEngine";
import { AudioGraph } from "../../../webapp/src/services/audio/outputs";

export interface AcceptanceProbe {
  player: NonNullable<ReturnType<typeof usePlayer>>;
  engine: PlaybackEngine | null;
  downloads: typeof offlineDownloadEngine;
  syncQueue: () => Promise<void>;
  renderEqualizer: () => Promise<{ peak: number; analyzerPeak: number; overloadPeak: number; maxBoostPeak: number; bypassPeak: number; bellCenter: number; bellAway: number }>;
  renderSleepFade: () => Promise<number[]>;
  benchmarkHydration: (distinct?: boolean) => Promise<{ count: number; distinct: boolean; runs: { ioMs: number; decodeMs: number; applyMs: number; totalMs: number }[] }>;
  benchmarkQueue: () => { timings: number[]; violations: string[]; count: number; currentUnchanged: boolean; orderCorrect: boolean };
}
declare global { interface Window { __acceptance: AcceptanceProbe } }

export function AcceptanceProbeComponent() {
  const player = usePlayer();
  useEffect(() => {
    if (player) window.__acceptance.player = player;
  }, [player]);
  return null;
}

// This benchmark invokes the same immutable reducer used by the mounted player.
// Queue/UI integration is asserted separately through player actions and the DOM.
window.__acceptance = {
  player: null as unknown as AcceptanceProbe["player"], engine: null,
  downloads: offlineDownloadEngine,
  syncQueue: () => queueSyncClient.sync(),
  async renderEqualizer() {
    const render = async (level: number, frequency = 30, mode: "graphic" | "parametric" | "max" | "bypass" = "graphic") => {
      const context = new OfflineAudioContext(1, 48000, 48000);
      const analyzer = context.createAnalyser();
      analyzer.connect(context.destination);
      const equalizer = new EqualizerEngine(context, analyzer);
      if (mode === "max") equalizer.setBands(Array(10).fill(12), 10);
      else if (mode === "parametric") {
        const bands = cleanParametricBands([{ type: "peaking", frequency: 1000, gain: -12, q: 5 }]);
        equalizer.setSettings({ enabled: true, mode: "parametric", parametric: bands, bandCount: 5, preset: "Flat", custom: [] });
      } else equalizer.setBands([6, 0, 0, 0, 0]);
      if (mode === "bypass") equalizer.setSettings({
        enabled: false, mode: "graphic", bandCount: 5, preset: "Bass Boost", custom: [], parametric: [],
      });
      const tone = context.createOscillator();
      tone.frequency.value = frequency;
      const gain = context.createGain();
      gain.gain.value = level;
      tone.connect(gain);
      gain.connect(equalizer.input);
      tone.start();
      const buffer = await context.startRendering();
      const peakOf = (samples: Float32Array) => samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
      const analyzerSamples = new Float32Array(analyzer.fftSize);
      analyzer.getFloatTimeDomainData(analyzerSamples);
      equalizer.dispose();
      return { peak: peakOf(buffer.getChannelData(0)), analyzerPeak: peakOf(analyzerSamples),
        settledPeak: peakOf(buffer.getChannelData(0).subarray(24000)) };
    };
    const normal = await render(1);
    return { ...normal, overloadPeak: (await render(4)).peak,
      maxBoostPeak: (await render(4, 1000, "max")).peak,
      bypassPeak: (await render(0.5, 30, "bypass")).peak,
      bellCenter: (await render(0.5, 1000, "parametric")).settledPeak,
      bellAway: (await render(0.5, 250, "parametric")).settledPeak };
  },
  async renderSleepFade() {
    const rate = 48000;
    const context = new OfflineAudioContext(1, 6 * rate, rate);
    const graph = new AudioGraph(context as unknown as AudioContext, false);
    const signal = context.createConstantSource();
    signal.offset.value = 0.5;
    signal.connect(graph.master);
    signal.start();
    graph.setSleepGain(0, 0.5, 5);
    const rendered = (await context.startRendering()).getChannelData(0);
    graph.dispose();
    return [0.25, 1.5, 3, 4.5, 5.75].map(time => rendered[Math.round(time * rate)]);
  },
  async benchmarkHydration(distinct = false) {
    const owner = "acceptance-benchmark", source = window.__acceptance.player.queue;
    const entries = Array.from({ length: 10_000 }, (_, i) => ({ entryId: `q${i}`, track: { ...sanitizeQueueTrack(source[i % source.length]),
      ...(distinct ? { id: `benchmark-track-${i}`, title: `Distinct recording ${i}` } : {}) } }));
    await writeLocalQueue(owner, { version: 2, entries }, { index: 9999, position: 42.875, repeatOne: false, shuffle: false, shuffleSeed: null, shuffleMode: "standard", albumAware: false, volume: 1, wasPlaying: false, context: null, capturedAt: Date.now() });
    const runs = [];
    try {
      for (let i = 0; i < 12; i++) {
        const start = performance.now(), saved = (await readLocalQueue(owner))!, applyStart = performance.now();
        const state = queueReducer(createQueueState(), { type: "HYDRATE_QUEUE", entries: saved.content.entries, index: saved.head.checkpoint.index, options: { deferLoad: true } });
        const applyMs = performance.now() - applyStart;
        const totalMs = performance.now() - start;
        if (state.entries.length !== 10_000 || queueInvariantViolations(state).length) throw new Error("Hydration lost queue entries");
        if (i >= 2) runs.push({ ...saved.timing, applyMs, totalMs });
      }
      return { count: entries.length, distinct, runs };
    } finally { await clearLocalQueue(owner); }
  },
  benchmarkQueue() {
    const tracks = Array.from({ length: 5000 }, (_, i) => ({ id: `bench-${i}`, title: `Track ${i}` }));
    let state = queueReducer(createQueueState(), { type: "SET_QUEUE", tracks, deferLoad: true });
    const current = state.entries[0];
    let orderCorrect = true;
    const timings: number[] = [];
    for (let i = 0; i < 120; i++) {
      const before = state.entries[4999];
      const started = performance.now();
      state = queueReducer(state, { type: "MOVE", from: 4999, to: 1 });
      const elapsed = performance.now() - started;
      if (i >= 20) timings.push(elapsed);
      orderCorrect &&= state.entries[1] === before;
    }
    return { timings, violations: queueInvariantViolations(state), count: state.entries.length, currentUnchanged: state.entries[0] === current, orderCorrect };
  },
};
