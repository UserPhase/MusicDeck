import { useSyncExternalStore } from "react";
import { tasteProfileStore } from "../services/TasteProfileStore";
export function useTasteProfile() {
  const state = useSyncExternalStore(tasteProfileStore.subscribe, tasteProfileStore.getSnapshot, tasteProfileStore.getSnapshot);
  return { ...state, setPrivate: tasteProfileStore.setPrivate, refresh: tasteProfileStore.refresh };
}
