/**
 * Joining a call's LiveKit room. Used by the /web and /react-native entry points
 * only: `livekit-client` is a peer dependency, and the core never imports it.
 */
import { Room, RoomEvent, type RoomConnectOptions, type RoomOptions } from "livekit-client";

import { HainivaAgentError } from "./errors.js";
import { Redactor } from "./redact.js";
import { assertSafeUrl } from "./url.js";

export interface MediaJoin {
  /** wss:// LiveKit URL. */
  url: string;
  /** Room token for this call — kept out of every error. */
  token: string;
}

export interface JoinOptions {
  /** Start with the microphone on. Default true. */
  microphone?: boolean;
  roomOptions?: RoomOptions;
  connectOptions?: RoomConnectOptions;
  /** ws://localhost in development. Default false. */
  allowInsecureLocalhost?: boolean;
  redactor?: Redactor;
}

export interface MediaCall {
  readonly room: Room;
  setMuted(muted: boolean): Promise<void>;
  /** Leave the room (idempotent). */
  leave(): Promise<void>;
  /** The room closed (far end hung up, server ended it, network lost). Returns an unsubscribe. */
  onDisconnected(fn: () => void): () => void;
}

/**
 * Join with the call's media credentials, microphone on. The token is handed to
 * LiveKit only; errors are redacted (LiveKit's own error text can contain its
 * signalling URL, which carries the token).
 */
export async function joinCallRoom(join: MediaJoin, o: JoinOptions = {}): Promise<MediaCall> {
  const redactor = o.redactor ?? new Redactor();
  redactor.add(join.token);
  assertSafeUrl(join.url, { kind: "ws", ...(o.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}) });
  if (!join.token) throw new HainivaAgentError(0, "no_media_token");
  const room = new Room(o.roomOptions);
  try {
    await room.connect(join.url, join.token, { autoSubscribe: true, ...o.connectOptions });
    if (o.microphone !== false) await room.localParticipant.setMicrophoneEnabled(true);
  } catch (e) {
    await room.disconnect().catch(() => undefined);
    throw HainivaAgentError.from(e, "media_connect_failed", redactor);
  }
  let left = false;
  return {
    room,
    async setMuted(muted) {
      try { await room.localParticipant.setMicrophoneEnabled(!muted); }
      catch (e) { throw HainivaAgentError.from(e, "media_mute_failed", redactor); }
    },
    async leave() {
      if (left) return;
      left = true;
      await room.disconnect().catch(() => undefined);
    },
    onDisconnected(fn) {
      const h = () => fn();
      room.on(RoomEvent.Disconnected, h);
      return () => { room.off(RoomEvent.Disconnected, h); };
    },
  };
}
