import type { Db } from "../db/database.js";

const listeners = new WeakMap<Db, Set<() => void>>();

export function subscribeSessionChanges(db: Db, listener: () => void): () => void {
  let subscriptions = listeners.get(db);
  if (!subscriptions) {
    subscriptions = new Set();
    listeners.set(db, subscriptions);
  }
  subscriptions.add(listener);
  return () => { subscriptions.delete(listener); };
}

/** Call only after the transaction changing authorization has committed. */
export function notifySessionChanges(db: Db): void {
  for (const listener of listeners.get(db) || []) listener();
}
