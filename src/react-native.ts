/**
 * @hainiva/agent-sdk/react-native — React Native adapters: the session in the
 * Keychain / Android Keystore (expo-secure-store) and LiveKit call media.
 *
 * Call `registerGlobals()` from `@livekit/react-native` once at startup before
 * joining a room. Native ringing (CallKit / Android call notification) is
 * `@hainiva/react-native-call`.
 */
import type { SessionStore } from "./session.js";

export { joinCallRoom, type JoinOptions, type MediaCall, type MediaJoin } from "./livekit.js";

/** The part of `expo-secure-store` this adapter uses: pass the module itself. */
export interface SecureStoreModule {
  getItemAsync(key: string, options?: Record<string, unknown>): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: Record<string, unknown>): Promise<void>;
  deleteItemAsync(key: string, options?: Record<string, unknown>): Promise<void>;
  /** expo-secure-store's constant; used as the default accessibility. */
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY?: unknown;
}

export interface SecureStoreSessionOptions {
  /** Default "hainiva.agent.session". Letters, digits, ".", "-" and "_" only. */
  key?: string;
  /**
   * iPhone Keychain accessibility. Default AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
   * readable while the phone is locked (a call that wakes the app must find the
   * session) and never migrated to another device.
   */
  keychainAccessible?: unknown;
}

/**
 * The session (and so the refresh token) in secure storage only. There is
 * deliberately no fallback to AsyncStorage or another plain store: if secure
 * storage fails, the session stays in memory and the next launch signs in again
 * with a fresh assertion.
 *
 *   import * as SecureStore from "expo-secure-store";
 *   const store = secureStoreSessionStore(SecureStore);
 */
export function secureStoreSessionStore(secure: SecureStoreModule, o: SecureStoreSessionOptions = {}): SessionStore {
  const key = o.key ?? "hainiva.agent.session";
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error("secureStoreSessionStore: key may use only letters, digits, '.', '-' and '_'");
  const access = o.keychainAccessible ?? secure.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
  const opts: Record<string, unknown> = access === undefined ? {} : { keychainAccessible: access };
  return {
    get: () => secure.getItemAsync(key, opts),
    set: (v) => secure.setItemAsync(key, v, opts),
    remove: () => secure.deleteItemAsync(key, opts),
  };
}
