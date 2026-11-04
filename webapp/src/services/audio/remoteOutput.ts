import type { EngineState, LoadOptions, PlayableTrack } from "./types";

export interface RemoteAudioSnapshot {
  key: string | null; state: EngineState; position: number; duration: number;
  ended?: boolean; disconnected?: boolean;
}
export interface RemoteAudioOutput {
  load(track: PlayableTrack, options: LoadOptions): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  getSnapshot(): RemoteAudioSnapshot;
  subscribe(listener: (snapshot: RemoteAudioSnapshot) => void): () => void;
}
