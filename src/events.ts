/**
 * The `/agent/v1/ws` protocol (v1) as ReconnectingSocket options, and the
 * mapping of its events to the SDK's typed events and to the call state machine.
 *
 *   client → auth {token, lastSeq?}   FIRST frame (the token never rides in the URL)
 *          → token.refresh {token, id} swap in a refreshed access token
 *          → ping
 *   server → ready {seq, expiresAt}
 *          → event {seq, event, data, at}
 *          → resync_required {fromSeq} events after your lastSeq are gone: refetch over REST
 *          → ack {id, ok, error?} · session.expiring {expiresAt} · pong · error {code}
 *   close  4001 token refused/expired (refresh, reconnect) · 4003 revoked (stop)
 *          4008 auth timeout · 4029 rate limited (reconnect with backoff)
 *          4009 too many sockets · 1003 binary frame (stop: retrying cannot fix them)
 *
 * The resume position travels in the auth frame, so the server replays from it
 * atomically with authentication (no window in which a live event overtakes
 * the replay).
 */
import type { CallEvent, CallInfo, CallsState } from "./calls.js";
import type { AgentCallEndedData, AgentCallRingingData, AgentEventName } from "./contract.js";
import { AGENT_EVENT_NAMES } from "./contract.js";
import type { SocketOptions } from "./ws.js";

export type { AgentEventName } from "./contract.js";

/** One event frame from the server. */
export interface AgentEventFrame<D = Record<string, unknown>> {
  v?: number;
  type: "event";
  event: AgentEventName;
  seq: number;
  at: string;
  data: D;
}

/** Any frame from the server. */
export type AgentServerFrame =
  | AgentEventFrame
  | { v?: number; type: "ready"; seq: number; expiresAt?: string; protocol?: number }
  | { v?: number; type: "resync_required"; fromSeq: number }
  | { v?: number; type: "ack"; id: string; ok: boolean; error?: string; expiresAt?: string }
  | { v?: number; type: "session.expiring"; expiresAt: string }
  | { v?: number; type: "pong" }
  | { v?: number; type: "error"; code?: string };

export type AgentClientFrame =
  | { type: "auth"; token: string; lastSeq?: number }
  | { type: "token.refresh"; token: string; id: string }
  | { type: "resume"; lastSeq: number; id?: string }
  | { type: "ping" };

export const AGENT_CLOSE_CODES = { tokenExpired: 4001, revoked: 4003, authTimeout: 4008, tooManySockets: 4009, rateLimited: 4029 } as const;

let tokenFrameSeq = 0;

/** The protocol as ReconnectingSocket options. `lastSeq()` is read when the auth frame is built. */
export function agentSocketBindings(lastSeq: () => number): Pick<SocketOptions<AgentServerFrame, AgentClientFrame>,
  "authFrame" | "isReady" | "resume" | "seqOf" | "tokenFrame" | "closeCodes" | "heartbeat"> {
  return {
    authFrame: (token) => {
      const s = lastSeq();
      return s > 0 ? { type: "auth", token, lastSeq: s } : { type: "auth", token };
    },
    isReady: (f) => f?.type === "ready",
    // Resume rides in the auth frame (above): no separate frame after ready.
    resume: () => null,
    seqOf: (f) => (f?.type === "event" && typeof f.seq === "number" && Number.isInteger(f.seq) ? f.seq : undefined),
    tokenFrame: (token) => ({ type: "token.refresh", token, id: `t${++tokenFrameSeq}` }),
    closeCodes: { tokenExpired: AGENT_CLOSE_CODES.tokenExpired, revoked: AGENT_CLOSE_CODES.revoked, fatal: [AGENT_CLOSE_CODES.tooManySockets, 1003] },
    // The server closes a socket that sends more than 120 frames a minute; 20 s is 3.
    heartbeat: { intervalMs: 20_000, timeoutMs: 60_000, frame: () => ({ type: "ping" }) },
  };
}

/** Is this a well-formed event frame with a name this SDK knows? Unknown names are passed on as `event.unknown`. */
export function isEventFrame(f: unknown): f is AgentEventFrame {
  const x = f as Record<string, unknown> | null;
  return !!x && x["type"] === "event" && typeof x["event"] === "string" && typeof x["seq"] === "number"
    && !!x["data"] && typeof x["data"] === "object" && !Array.isArray(x["data"]);
}

export const isKnownEvent = (name: string): name is AgentEventName => (AGENT_EVENT_NAMES as readonly string[]).includes(name);

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Pure: call.ringing data → the state machine's CallInfo (null when malformed). */
export function ringInfo(d: Record<string, unknown>, now: number, defaultRingMs: number): CallInfo | null {
  const r = d as Partial<AgentCallRingingData>;
  const callId = str(r.callId);
  if (!callId) return null;
  const path = r.path === "direct" || r.path === "queue" || r.path === "transfer" ? r.path : "queue";
  const exp = str(r.expiresAt) ? Date.parse(r.expiresAt as string) : NaN;
  const conversationId = str(r.conversationId);
  const line = str(r.line);
  return {
    id: callId,
    ...(conversationId ? { conversationId } : {}),
    direction: "inbound",
    path,
    from: str(r.contactName) ?? str(r.callerNumber) ?? str(r.fromAgentName) ?? "",
    ...(line ? { line } : {}),
    // A ring without an end the server knows still ends: a lost cancel must not leave a ghost ring.
    expiresAt: Number.isFinite(exp) ? exp : now + defaultRingMs,
    ...(path === "transfer" ? { transfer: { mode: r.transferMode === "blind" ? "blind" : "warm" } } : {}),
  };
}

/**
 * Pure: an event → the state-machine events it causes (empty when it is not
 * about calls this device knows). `state` resolves a call.ended that names only
 * the conversation.
 */
export function toCallEvents(frame: AgentEventFrame, state: CallsState, now: number, defaultRingMs = 60_000): CallEvent[] {
  if (frame.event === "call.ringing") {
    const call = ringInfo(frame.data, now, defaultRingMs);
    return call ? [{ type: "ring", call, at: now }] : [];
  }
  if (frame.event !== "call.ended") return [];
  const d = frame.data as Partial<AgentCallEndedData>;
  const ids: string[] = [];
  const callId = str(d.callId);
  if (callId) ids.push(callId);
  else if (str(d.conversationId)) {
    for (const c of Object.values(state.calls)) if (c.info.conversationId === d.conversationId && c.phase !== "ended") ids.push(c.info.id);
  }
  const out: CallEvent[] = [];
  for (const id of ids) {
    const c = state.calls[id];
    if (!c || c.phase === "ended") continue;
    if (c.phase === "ringing" || c.phase === "connecting") {
      const reason = d.reason === "answered_elsewhere" ? "answered_elsewhere"
        : d.reason === "ended" || d.reason === "failed" ? "remote_ended" : "cancelled";
      out.push({ type: "ring_cancelled", id, reason, at: now });
    } else if (d.reason !== "answered_elsewhere") {
      // On the call: the caller hung up, the server ended it, or a blind transfer handed it over.
      out.push({ type: "remote_end", id, at: now });
    }
  }
  return out;
}
