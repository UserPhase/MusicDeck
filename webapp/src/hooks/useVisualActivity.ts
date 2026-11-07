import { useSyncExternalStore } from "react";
import { getVisualActivity, subscribeVisualActivity } from "../services/visualActivity";

export function useVisualActivity(): boolean {
  return useSyncExternalStore(subscribeVisualActivity, getVisualActivity, () => true);
}
