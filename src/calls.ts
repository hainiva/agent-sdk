import { TypedEmitter } from "./emitter.js";

/**
 * The agent's calls as a pure state machine — ported from the HAINIVA Agent app
 * (apps/agent-mobile/src/calls.ts), without React Native, LiveKit or HTTP: the
 * host feeds it events (a ring push, the user's answer, "media connected", the
 * server's cancel…) and acts on the effects it returns (stop the native ring,
 * leave the room). Same rules as the app:
 *
 *  - one call at a time: a ring while on a call is turned away ("busy"), and
 *    answering one ring turns away the others;
 *  - a ring ends at its expiresAt ("missed"), when declined, or when the server
 *    cancels it (taken elsewhere, caller gone);
 *  - while answering, "taken elsewhere" is ignored (the server's answer race
 *    decides, via accept_failed) but the caller hanging up ends it, and media
 *    that connects after that is left at once;
 *  - hold, mute and warm/blind transfer as on the desk.
 *
 *   ringing ──accept──▶ connecting ──connected──▶ active ⇄ held
 *      │                    │                       │  └─transfer_start─▶ transferring
 *      ├─decline/expire/    └─accept_failed/        │                       │
 *      │ ring_cancelled       remote_end/hang_up    └─remote_end/hang_up    ├─transfer_completed
 *      ▼                         ▼                         ▼                ▼
 *    ended ◀──────────────────────────────────────────────────────────── ended
 */

export type CallDirection = "inbound" | "outbound";
/** direct / queue: a ring; transfer: a colleague's transfer invite; out: placed here. */
export type CallPath = "direct" | "queue" | "transfer" | "out";

export interface CallInfo {
  /** The interaction id (or a client id for an outgoing call until the server's arrives). */
  id: string;
  conversationId?: string;
  direction: CallDirection;
  path: CallPath;
  /** Caller (inbound) or callee (outbound) as shown. */
  from: string;
  line?: string;
  /** Epoch ms when an unanswered ring ends. */
  expiresAt?: number;
  /** A transfer invite: how the colleague is handing it over. */
  transfer?: { mode: "warm" | "blind" };
}

export type CallPhase = "ringing" | "connecting" | "active" | "held" | "transferring" | "ended";

export type EndReason =
  | "declined"            // turned down here
  | "missed"              // the ring expired
  | "answered_elsewhere"  // another device / agent took it
  | "remote_ended"        // the caller, the far end or the server ended it
  | "hung_up"             // ended here
  | "transferred"         // handed over to someone else
  | "busy"                // turned away: this agent was on another call
  | "failed"              // could not connect
  | "cancelled";          // the ring was withdrawn for another reason

export type TransferTarget =
  | { kind: "agent"; agentId: string; name: string }
  | { kind: "queue"; queueId: string; name: string }
  | { kind: "external"; number: string };

export interface TransferState {
  mode: "warm" | "blind";
  target: TransferTarget;
  /** Warm: the colleague / number is in the call. */
  joined: boolean;
  startedAt: number;
  /** Where a cancelled transfer returns to. */
  resumeTo: "active" | "held";
}

export interface Call {
  readonly info: CallInfo;
  readonly phase: CallPhase;
  readonly muted: boolean;
  /** When talking started; null while an outgoing call still rings at the far end. */
  readonly since: number | null;
  readonly ringingSince: number | null;
  readonly transfer: TransferState | null;
  /** A short note for the UI (e.g. "colleague left"). */
  readonly notice: string | null;
  readonly endReason: EndReason | null;
  readonly endedAt: number | null;
  readonly error: string | null;
}

export interface CallsState {
  readonly calls: Readonly<Record<string, Call>>;
  /** The call that holds the line (connecting, active, held, transferring), if any. */
  readonly activeId: string | null;
}

export const initialCallsState: CallsState = Object.freeze({ calls: Object.freeze({}), activeId: null });

export type CallEvent =
  | { type: "ring"; call: CallInfo; at: number }
  | { type: "dial"; call: CallInfo; at: number }
  | { type: "accept"; id: string; at: number }
  | { type: "decline"; id: string; at: number }
  | { type: "expire"; id: string; at: number }
  | { type: "ring_cancelled"; id: string; reason: "answered_elsewhere" | "remote_ended" | "cancelled"; at: number }
  | { type: "accept_failed"; id: string; reason: "answered_elsewhere" | "gone" | "failed"; error?: string; at: number }
  | { type: "connected"; id: string; answered: boolean; at: number }
  | { type: "answered"; id: string; at: number }
  | { type: "mute"; id: string; muted: boolean }
  | { type: "hold"; id: string }
  | { type: "resume"; id: string }
  | { type: "transfer_start"; id: string; mode: "warm" | "blind"; target: TransferTarget; at: number }
  | { type: "transfer_joined"; id: string }
  | { type: "transfer_cancelled"; id: string; notice?: string }
  | { type: "transfer_completed"; id: string; at: number }
  | { type: "remote_end"; id: string; at: number }
  | { type: "hang_up"; id: string; at: number }
  | { type: "rekey"; id: string; newId: string; conversationId?: string }
  | { type: "dismiss"; id: string };

/** What the host must do after a transition. */
export type CallEffect =
  | { type: "ring.show"; call: CallInfo }
  /** Stop this device ringing for the call (native ring / CallKit). */
  | { type: "ring.cancel"; id: string }
  /** Leave the call's media room (or never join it). */
  | { type: "media.leave"; id: string }
  | { type: "ended"; id: string; reason: EndReason };

export interface Transition {
  state: CallsState;
  effects: CallEffect[];
  /** False when the event did not apply (state is the same object). */
  changed: boolean;
}

const LIVE: ReadonlySet<CallPhase> = new Set<CallPhase>(["connecting", "active", "held", "transferring"]);
const IN_CALL: ReadonlySet<CallPhase> = new Set<CallPhase>(["active", "held", "transferring"]);

function newCall(info: CallInfo, phase: CallPhase, at: number): Call {
  return { info, phase, muted: false, since: null, ringingSince: phase === "ringing" ? at : null, transfer: null, notice: null, endReason: null, endedAt: null, error: null };
}

function activeOf(calls: Record<string, Call>): string | null {
  for (const c of Object.values(calls)) if (LIVE.has(c.phase)) return c.info.id;
  return null;
}

/** Apply one event. Pure: never mutates `state`. */
export function transition(state: CallsState, ev: CallEvent): Transition {
  const calls: Record<string, Call> = { ...state.calls };
  const effects: CallEffect[] = [];
  const same: Transition = { state, effects: [], changed: false };
  const id = ev.type === "ring" || ev.type === "dial" ? ev.call.id : ev.id;
  const c = calls[id];

  const put = (next: Call) => { calls[next.info.id] = next; };
  const end = (call: Call, reason: EndReason, at: number, extra: Partial<Call> = {}) => {
    if (call.phase === "ringing") effects.push({ type: "ring.cancel", id: call.info.id });
    else if (LIVE.has(call.phase)) effects.push({ type: "media.leave", id: call.info.id });
    put({ ...call, ...extra, phase: "ended", endReason: reason, endedAt: at, transfer: null });
    effects.push({ type: "ended", id: call.info.id, reason });
  };
  const done = (): Transition => {
    const next: CallsState = { calls, activeId: activeOf(calls) };
    return { state: next, effects, changed: true };
  };

  switch (ev.type) {
    case "ring": {
      if (!ev.call.id) return same;
      if (c && c.phase !== "ended") return same;                 // the same ring again (push + socket)
      if (ev.call.expiresAt !== undefined && ev.call.expiresAt <= ev.at) return same; // arrived too late
      if (state.activeId) {
        // On a call: this device turns it away (iPhone: CallKit already shows it).
        return { state, effects: [{ type: "ring.cancel", id }], changed: false };
      }
      put(newCall({ ...ev.call, direction: "inbound" }, "ringing", ev.at));
      effects.push({ type: "ring.show", call: ev.call });
      return done();
    }
    case "dial": {
      if (!ev.call.id || state.activeId) return same;
      if (Object.values(state.calls).some((x) => x.phase === "ringing")) return same; // answer or decline first
      if (c && c.phase !== "ended") return same;
      put(newCall({ ...ev.call, direction: "outbound", path: "out" }, "connecting", ev.at));
      return done();
    }
    case "accept": {
      if (!c || c.phase !== "ringing" || state.activeId) return same;
      if (c.info.expiresAt !== undefined && c.info.expiresAt <= ev.at) { end(c, "missed", ev.at); return done(); }
      effects.push({ type: "ring.cancel", id });
      put({ ...c, phase: "connecting" });
      for (const other of Object.values(calls)) {
        if (other.info.id !== id && other.phase === "ringing") end(other, "busy", ev.at);
      }
      return done();
    }
    case "decline": {
      if (!c || c.phase !== "ringing") return same;
      end(c, "declined", ev.at);
      return done();
    }
    case "expire": {
      if (!c || c.phase !== "ringing") return same;
      if (c.info.expiresAt !== undefined && c.info.expiresAt > ev.at) return same;
      end(c, "missed", ev.at);
      return done();
    }
    case "ring_cancelled": {
      if (!c) return same;
      if (c.phase === "ringing") { end(c, ev.reason, ev.at); return done(); }
      // Answering here: "taken elsewhere" is about the race the server decides
      // (accept_failed tells); the caller hanging up ends it.
      if (c.phase === "connecting" && ev.reason === "remote_ended") { end(c, "remote_ended", ev.at); return done(); }
      return same;
    }
    case "accept_failed": {
      if (!c || c.phase !== "connecting") return same;
      const reason: EndReason = ev.reason === "answered_elsewhere" ? "answered_elsewhere" : ev.reason === "gone" ? "remote_ended" : "failed";
      end(c, reason, ev.at, { error: ev.error ?? null });
      return done();
    }
    case "connected": {
      if (!c || c.phase === "ended") {
        // Media came up after the call ended (caller hung up during the answer): leave it.
        return { state, effects: [{ type: "media.leave", id }], changed: false };
      }
      if (c.phase !== "connecting") return same;
      put({ ...c, phase: "active", since: ev.answered ? ev.at : null, muted: false });
      return done();
    }
    case "answered": {
      if (!c || !IN_CALL.has(c.phase) || c.since !== null) return same;
      put({ ...c, since: ev.at });
      return done();
    }
    case "mute": {
      if (!c || !IN_CALL.has(c.phase) || c.muted === ev.muted) return same;
      put({ ...c, muted: ev.muted });
      return done();
    }
    case "hold": {
      if (!c || c.phase !== "active") return same;
      put({ ...c, phase: "held" });
      return done();
    }
    case "resume": {
      if (!c || c.phase !== "held") return same;
      put({ ...c, phase: "active" });
      return done();
    }
    case "transfer_start": {
      if (!c || (c.phase !== "active" && c.phase !== "held")) return same;
      const mode = ev.target.kind === "queue" ? "blind" : ev.mode;
      put({ ...c, phase: "transferring", notice: null, transfer: { mode, target: ev.target, joined: false, startedAt: ev.at, resumeTo: c.phase } });
      return done();
    }
    case "transfer_joined": {
      if (!c || c.phase !== "transferring" || !c.transfer || c.transfer.mode !== "warm" || c.transfer.joined) return same;
      put({ ...c, transfer: { ...c.transfer, joined: true } });
      return done();
    }
    case "transfer_cancelled": {
      if (!c || c.phase !== "transferring" || !c.transfer) return same;
      put({ ...c, phase: c.transfer.resumeTo, transfer: null, notice: ev.notice ?? null });
      return done();
    }
    case "transfer_completed": {
      if (!c || c.phase !== "transferring") return same;
      end(c, "transferred", ev.at);
      return done();
    }
    case "remote_end": {
      if (!c || c.phase === "ended") return same;
      // A blind transfer ends here when the server hands the call over.
      const reason: EndReason = c.phase === "transferring" && c.transfer?.mode === "blind" ? "transferred" : "remote_ended";
      end(c, reason, ev.at);
      return done();
    }
    case "hang_up": {
      if (!c || !LIVE.has(c.phase)) return same;
      end(c, "hung_up", ev.at);
      return done();
    }
    case "rekey": {
      // An outgoing call learns its server id.
      if (!c || c.phase === "ended" || !ev.newId || ev.newId === id || calls[ev.newId]) return same;
      delete calls[id];
      put({ ...c, info: { ...c.info, id: ev.newId, ...(ev.conversationId ? { conversationId: ev.conversationId } : {}) } });
      return done();
    }
    case "dismiss": {
      if (!c || c.phase !== "ended") return same;
      delete calls[id];
      return done();
    }
  }
}

/** The call holding the line, if any. */
export function activeCall(state: CallsState): Call | null {
  return state.activeId ? state.calls[state.activeId] ?? null : null;
}

/** Calls ringing now, oldest first. */
export function ringingCalls(state: CallsState): Call[] {
  return Object.values(state.calls).filter((c) => c.phase === "ringing").sort((a, b) => (a.ringingSince ?? 0) - (b.ringingSince ?? 0));
}

export interface CallStoreEvents {
  change: CallsState;
  effect: CallEffect;
}

export interface CallStoreOptions {
  now?: () => number;
  /** Remove ended calls this long after they end (0 = keep until dismissed). Default 0. */
  forgetEndedAfterMs?: number;
}

/**
 * The state machine with a clock: rings expire on their own, and listeners hear
 * every change and effect. Still free of React Native, LiveKit and HTTP.
 */
export class CallStore {
  readonly events = new TypedEmitter<CallStoreEvents>();
  private st: CallsState = initialCallsState;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;

  constructor(private readonly o: CallStoreOptions = {}) {
    this.now = o.now ?? Date.now;
  }

  get state(): CallsState { return this.st; }

  /** Apply an event. `at` is filled from the clock when omitted. */
  dispatch(ev: DistributiveOmit<CallEvent, "at"> & { at?: number }): Transition {
    const full = ("at" in ev && typeof ev.at === "number" ? ev : { ...ev, at: this.now() }) as CallEvent;
    const t = transition(this.st, full);
    if (t.changed) {
      this.st = t.state;
      this.syncTimers();
      this.events.emit("change", this.st);
    }
    for (const e of t.effects) this.events.emit("effect", e);
    return t;
  }

  /** Stop every timer (e.g. on sign-out). */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.events.removeAll();
  }

  private syncTimers(): void {
    for (const [key, t] of this.timers) {
      const cut = key.indexOf(":");
      const kind = key.slice(0, cut);
      const id = key.slice(cut + 1);
      const c = this.st.calls[id];
      if (!c || (kind === "expire" && c.phase !== "ringing") || (kind === "forget" && c.phase !== "ended")) {
        clearTimeout(t);
        this.timers.delete(key);
      }
    }
    for (const c of Object.values(this.st.calls)) {
      const id = c.info.id;
      if (c.phase === "ringing" && c.info.expiresAt !== undefined && !this.timers.has(`expire:${id}`)) {
        const left = Math.max(0, c.info.expiresAt - this.now());
        this.timers.set(`expire:${id}`, setTimeout(() => {
          this.timers.delete(`expire:${id}`);
          this.dispatch({ type: "expire", id, at: Math.max(this.now(), c.info.expiresAt ?? 0) });
        }, left));
      }
      const forget = this.o.forgetEndedAfterMs ?? 0;
      if (c.phase === "ended" && forget > 0 && !this.timers.has(`forget:${id}`)) {
        this.timers.set(`forget:${id}`, setTimeout(() => {
          this.timers.delete(`forget:${id}`);
          this.dispatch({ type: "dismiss", id });
        }, forget));
      }
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
