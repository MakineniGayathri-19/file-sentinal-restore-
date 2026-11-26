import { useSyncExternalStore } from "react";
import { Sentinel } from "./engine";
import { createIdbRepo } from "./idb-repo";

/** One engine per browser tab; never created during server rendering. */
let engine: Sentinel | null = null;
let initPromise: Promise<Sentinel> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const notify = () => {
  version++;
  for (const l of listeners) l();
};

export function getSentinel(): Promise<Sentinel> {
  if (typeof window === "undefined")
    return Promise.reject(new Error("Sentinel runs in the browser only"));
  if (!initPromise) {
    const e = new Sentinel(createIdbRepo());
    initPromise = e.init().then(() => {
      engine = e;
      e.subscribe(notify);
      notify();
      void e.startup();
      return e;
    });
  }
  return initPromise;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  void getSentinel().catch(() => undefined);
  return () => listeners.delete(fn);
}

/** Returns the ready engine (re-rendering on every change) or null while loading / on the server. */
export function useSentinel(): Sentinel | null {
  const v = useSyncExternalStore(
    subscribe,
    () => version,
    () => -1,
  );
  return v < 0 ? null : engine;
}
