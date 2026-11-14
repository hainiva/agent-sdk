/**
 * @hainiva/agent-sdk/web — browser adapters: an opt-in localStorage session store
 * and LiveKit call media (peer dependency `livekit-client`).
 */
import type { SessionStore } from "./session.js";

export { memoryStore } from "./session.js";
export { joinCallRoom, type JoinOptions, type MediaCall, type MediaJoin } from "./livekit.js";

export interface LocalStorageStoreOptions {
  /** Default "hainiva.agent.session". */
  key?: string;
  /** Default globalThis.localStorage. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/**
 * OPT-IN: keep the session in localStorage so a reload stays signed in.
 *
 * ⚠ Any script running on your origin (an XSS, a compromised third-party script)
 * can read localStorage — including the 30-day refresh token. Use it only with a
 * strict Content-Security-Policy and no third-party scripts on the page. The
 * default (memoryStore) keeps nothing: a reload signs in again with a fresh
 * assertion from your backend, which is the safer choice.
 */
export function localStorageStore(o: LocalStorageStoreOptions = {}): SessionStore {
  const key = o.key ?? "hainiva.agent.session";
  const storage = o.storage ?? (globalThis as { localStorage?: Storage }).localStorage;
  if (!storage) throw new Error("localStorage is not available here; use memoryStore()");
  return {
    get: () => storage.getItem(key),
    set: (v) => storage.setItem(key, v),
    remove: () => storage.removeItem(key),
  };
}
