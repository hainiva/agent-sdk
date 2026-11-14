import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CallStore, activeCall, initialCallsState, ringingCalls, transition,
  type CallEvent, type CallInfo, type CallsState,
} from "./calls.js";

const T0 = 1_000_000;
const ring = (id: string, over: Partial<CallInfo> = {}): CallInfo => ({ id, direction: "inbound", path: "queue", from: `Caller ${id}`, line: "1900", expiresAt: T0 + 30_000, ...over });

/** Apply events in order; returns the final transition and every effect seen. */
function run(events: CallEvent[], from: CallsState = initialCallsState) {
  let state = from;
  const effects: unknown[] = [];
  let last = { state, effects: [] as unknown[], changed: false };
  for (const e of events) {
    const t = transition(state, e);
    state = t.state;
    effects.push(...t.effects);
    last = t;
  }
  return { state, effects, last };
}
const ringing = (id = "a") => run([{ type: "ring", call: ring(id), at: T0 }]).state;
const connecting = (id = "a") => run([{ type: "accept", id, at: T0 + 1 }], ringing(id)).state;
const active = (id = "a", answered = true) => run([{ type: "connected", id, answered, at: T0 + 2 }], connecting(id)).state;

describe("ringing", () => {
  it("a ring shows and becomes the ringing call", () => {
    const { state, effects } = run([{ type: "ring", call: ring("a"), at: T0 }]);
    expect(state.calls["a"]?.phase).toBe("ringing");
    expect(state.calls["a"]?.ringingSince).toBe(T0);
    expect(state.activeId).toBeNull();
    expect(effects).toEqual([{ type: "ring.show", call: ring("a") }]);
  });

  it("the same ring twice (push + socket) is one ring", () => {
    const t = transition(ringing("a"), { type: "ring", call: ring("a"), at: T0 + 5 });
    expect(t.changed).toBe(false);
    expect(t.effects).toEqual([]);
  });

  it("a ring that arrives already expired is ignored", () => {
    const t = transition(initialCallsState, { type: "ring", call: ring("a", { expiresAt: T0 }), at: T0 });
    expect(t.changed).toBe(false);
  });

  it("a ring without an id is ignored", () => {
    expect(transition(initialCallsState, { type: "ring", call: ring(""), at: T0 }).changed).toBe(false);
  });

  it("ringing → accepted: connecting, the native ring stops, the line is taken", () => {
    const t = transition(ringing("a"), { type: "accept", id: "a", at: T0 + 1 });
    expect(t.state.calls["a"]?.phase).toBe("connecting");
    expect(t.state.activeId).toBe("a");
    expect(t.effects).toEqual([{ type: "ring.cancel", id: "a" }]);
  });

  it("ringing → declined", () => {
    const t = transition(ringing("a"), { type: "decline", id: "a", at: T0 + 1 });
    expect(t.state.calls["a"]).toMatchObject({ phase: "ended", endReason: "declined", endedAt: T0 + 1 });
    expect(t.effects).toEqual([{ type: "ring.cancel", id: "a" }, { type: "ended", id: "a", reason: "declined" }]);
  });

  it("ringing → missed when it expires", () => {
    const t = transition(ringing("a"), { type: "expire", id: "a", at: T0 + 30_000 });
    expect(t.state.calls["a"]).toMatchObject({ phase: "ended", endReason: "missed" });
    expect(t.effects).toContainEqual({ type: "ring.cancel", id: "a" });
  });

  it("an early expire timer does not end the ring", () => {
    expect(transition(ringing("a"), { type: "expire", id: "a", at: T0 + 10 }).changed).toBe(false);
  });

  it("accepting a ring that has just expired makes it missed, not connecting", () => {
    const t = transition(ringing("a"), { type: "accept", id: "a", at: T0 + 30_000 });
    expect(t.state.calls["a"]).toMatchObject({ phase: "ended", endReason: "missed" });
    expect(t.state.activeId).toBeNull();
  });

  it("the server cancels the ring: taken elsewhere / caller gone / withdrawn", () => {
    for (const reason of ["answered_elsewhere", "remote_ended", "cancelled"] as const) {
      const t = transition(ringing("a"), { type: "ring_cancelled", id: "a", reason, at: T0 + 3 });
      expect(t.state.calls["a"]).toMatchObject({ phase: "ended", endReason: reason });
      expect(t.effects[0]).toEqual({ type: "ring.cancel", id: "a" });
    }
  });

  it("the caller hangs up while it rings (remote_end) ends it", () => {
    const t = transition(ringing("a"), { type: "remote_end", id: "a", at: T0 + 3 });
    expect(t.state.calls["a"]).toMatchObject({ phase: "ended", endReason: "remote_ended" });
    expect(t.effects[0]).toEqual({ type: "ring.cancel", id: "a" });
  });

  it("decline / accept / expire of an unknown call do nothing", () => {
    for (const type of ["decline", "accept", "expire", "hang_up", "remote_end"] as const) {
      expect(transition(initialCallsState, { type, id: "x", at: T0 }).changed).toBe(false);
    }
  });

  it("a call can ring again after its earlier ring ended (re-ring)", () => {
    const ended = run([{ type: "decline", id: "a", at: T0 + 1 }], ringing("a")).state;
    const t = transition(ended, { type: "ring", call: ring("a"), at: T0 + 2 });
    expect(t.state.calls["a"]?.phase).toBe("ringing");
  });
});

describe("concurrent rings", () => {
  const two = () => run([
    { type: "ring", call: ring("a"), at: T0 },
    { type: "ring", call: ring("b"), at: T0 + 1 },
  ]).state;

  it("two rings at once both ring, oldest first", () => {
    const s = two();
    expect(ringingCalls(s).map((c) => c.info.id)).toEqual(["a", "b"]);
    expect(s.activeId).toBeNull();
  });

  it("answering one turns the other away (busy) and stops its ring", () => {
    const t = transition(two(), { type: "accept", id: "b", at: T0 + 2 });
    expect(t.state.calls["b"]?.phase).toBe("connecting");
    expect(t.state.calls["a"]).toMatchObject({ phase: "ended", endReason: "busy" });
    expect(t.effects).toEqual([
      { type: "ring.cancel", id: "b" },
      { type: "ring.cancel", id: "a" },
      { type: "ended", id: "a", reason: "busy" },
    ]);
  });

  it("a second accept while connecting is refused", () => {
    const s = run([{ type: "ring", call: ring("b"), at: T0 + 1 }], connecting("a")).state;
    // b was turned away on arrival (busy), so there is nothing to accept.
    expect(s.calls["b"]).toBeUndefined();
    expect(transition(s, { type: "accept", id: "b", at: T0 + 2 }).changed).toBe(false);
  });

  it("a ring while on a call is turned away: no state, ring.cancel (CallKit already shows it)", () => {
    const t = transition(active("a"), { type: "ring", call: ring("b"), at: T0 + 5 });
    expect(t.changed).toBe(false);
    expect(t.state.calls["b"]).toBeUndefined();
    expect(t.effects).toEqual([{ type: "ring.cancel", id: "b" }]);
  });

  it("declining one leaves the other ringing", () => {
    const t = transition(two(), { type: "decline", id: "a", at: T0 + 2 });
    expect(t.state.calls["b"]?.phase).toBe("ringing");
  });
});

describe("connecting", () => {
  it("connecting → active when media joins (since = now for an answered call)", () => {
    const t = transition(connecting("a"), { type: "connected", id: "a", answered: true, at: T0 + 2 });
    expect(t.state.calls["a"]).toMatchObject({ phase: "active", since: T0 + 2, muted: false });
    expect(activeCall(t.state)?.info.id).toBe("a");
  });

  it("taken elsewhere while answering is left to the server's race", () => {
    expect(transition(connecting("a"), { type: "ring_cancelled", id: "a", reason: "answered_elsewhere", at: T0 + 2 }).changed).toBe(false);
  });

  it("the server says it was taken elsewhere (accept_failed) → ended, room left", () => {
    const t = transition(connecting("a"), { type: "accept_failed", id: "a", reason: "answered_elsewhere", at: T0 + 2 });
    expect(t.state.calls["a"]).toMatchObject({ phase: "ended", endReason: "answered_elsewhere" });
    expect(t.state.activeId).toBeNull();
    expect(t.effects).toContainEqual({ type: "media.leave", id: "a" });
  });

  it("accept_failed: gone → remote_ended, failed → failed with the error", () => {
    expect(transition(connecting("a"), { type: "accept_failed", id: "a", reason: "gone", at: T0 + 2 }).state.calls["a"]?.endReason).toBe("remote_ended");
    const f = transition(connecting("a"), { type: "accept_failed", id: "a", reason: "failed", error: "timeout", at: T0 + 2 });
    expect(f.state.calls["a"]).toMatchObject({ endReason: "failed", error: "timeout" });
  });

  it("remote end during accept: ended, and media that connects afterwards is left at once", () => {
    const ended = transition(connecting("a"), { type: "ring_cancelled", id: "a", reason: "remote_ended", at: T0 + 2 });
    expect(ended.state.calls["a"]).toMatchObject({ phase: "ended", endReason: "remote_ended" });
    expect(ended.effects).toContainEqual({ type: "media.leave", id: "a" });
    const late = transition(ended.state, { type: "connected", id: "a", answered: true, at: T0 + 3 });
    expect(late.changed).toBe(false);
    expect(late.state.calls["a"]?.phase).toBe("ended");
    expect(late.effects).toEqual([{ type: "media.leave", id: "a" }]);
  });

  it("remote_end during accept also ends it", () => {
    const t = transition(connecting("a"), { type: "remote_end", id: "a", at: T0 + 2 });
    expect(t.state.calls["a"]?.endReason).toBe("remote_ended");
  });

  it("hanging up while connecting", () => {
    const t = transition(connecting("a"), { type: "hang_up", id: "a", at: T0 + 2 });
    expect(t.state.calls["a"]?.endReason).toBe("hung_up");
    expect(t.effects).toContainEqual({ type: "media.leave", id: "a" });
  });

  it("connected for an unknown call → leave that room", () => {
    const t = transition(initialCallsState, { type: "connected", id: "zz", answered: true, at: T0 });
    expect(t.effects).toEqual([{ type: "media.leave", id: "zz" }]);
  });
});

describe("outgoing calls", () => {
  const out: CallInfo = { id: "c1", direction: "outbound", path: "out", from: "0901234567" };

  it("dial → connecting → active (still ringing at the far end) → answered", () => {
    const { state } = run([
      { type: "dial", call: out, at: T0 },
      { type: "connected", id: "c1", answered: false, at: T0 + 1 },
    ]);
    expect(state.calls["c1"]).toMatchObject({ phase: "active", since: null });
    const t = transition(state, { type: "answered", id: "c1", at: T0 + 5 });
    expect(t.state.calls["c1"]?.since).toBe(T0 + 5);
    expect(transition(t.state, { type: "answered", id: "c1", at: T0 + 9 }).changed).toBe(false);
  });

  it("rekey: the client id becomes the server's interaction id", () => {
    const s = run([{ type: "dial", call: out, at: T0 }]).state;
    const t = transition(s, { type: "rekey", id: "c1", newId: "int-9", conversationId: "conv-1" });
    expect(t.state.calls["c1"]).toBeUndefined();
    expect(t.state.calls["int-9"]?.info).toMatchObject({ id: "int-9", conversationId: "conv-1" });
    expect(t.state.activeId).toBe("int-9");
  });

  it("no dialling while on a call or while something rings", () => {
    expect(transition(active("a"), { type: "dial", call: out, at: T0 }).changed).toBe(false);
    expect(transition(ringing("a"), { type: "dial", call: out, at: T0 }).changed).toBe(false);
  });
});

describe("active / held", () => {
  it("active → held → active", () => {
    const held = transition(active("a"), { type: "hold", id: "a" });
    expect(held.state.calls["a"]?.phase).toBe("held");
    expect(held.state.activeId).toBe("a");
    expect(transition(held.state, { type: "hold", id: "a" }).changed).toBe(false);
    const back = transition(held.state, { type: "resume", id: "a" });
    expect(back.state.calls["a"]?.phase).toBe("active");
    expect(transition(back.state, { type: "resume", id: "a" }).changed).toBe(false);
  });

  it("mute is kept across hold", () => {
    const muted = transition(active("a"), { type: "mute", id: "a", muted: true }).state;
    const held = transition(muted, { type: "hold", id: "a" }).state;
    expect(held.calls["a"]?.muted).toBe(true);
    expect(transition(held, { type: "resume", id: "a" }).state.calls["a"]?.muted).toBe(true);
    expect(transition(held, { type: "mute", id: "a", muted: true }).changed).toBe(false);
  });

  it("no mute / hold while ringing", () => {
    expect(transition(ringing("a"), { type: "mute", id: "a", muted: true }).changed).toBe(false);
    expect(transition(ringing("a"), { type: "hold", id: "a" }).changed).toBe(false);
  });

  it("active → ended by the far end", () => {
    const t = transition(active("a"), { type: "remote_end", id: "a", at: T0 + 9 });
    expect(t.state.calls["a"]).toMatchObject({ phase: "ended", endReason: "remote_ended", endedAt: T0 + 9 });
    expect(t.state.activeId).toBeNull();
    expect(t.effects).toEqual([{ type: "media.leave", id: "a" }, { type: "ended", id: "a", reason: "remote_ended" }]);
  });

  it("held → hung up here", () => {
    const held = transition(active("a"), { type: "hold", id: "a" }).state;
    expect(transition(held, { type: "hang_up", id: "a", at: T0 + 9 }).state.calls["a"]?.endReason).toBe("hung_up");
  });

  it("a ring is accepted only after the line is free again", () => {
    const ended = transition(active("a"), { type: "hang_up", id: "a", at: T0 + 9 }).state;
    const s = run([{ type: "ring", call: ring("b"), at: T0 + 10 }, { type: "accept", id: "b", at: T0 + 11 }], ended).state;
    expect(s.activeId).toBe("b");
  });
});

describe("transferring", () => {
  const agent = { kind: "agent" as const, agentId: "ag2", name: "Lan" };

  it("warm: active → transferring → colleague joins → completed (ended, transferred)", () => {
    const t1 = transition(active("a"), { type: "transfer_start", id: "a", mode: "warm", target: agent, at: T0 + 5 });
    expect(t1.state.calls["a"]).toMatchObject({ phase: "transferring", transfer: { mode: "warm", joined: false, startedAt: T0 + 5, resumeTo: "active" } });
    const t2 = transition(t1.state, { type: "transfer_joined", id: "a" });
    expect(t2.state.calls["a"]?.transfer?.joined).toBe(true);
    expect(transition(t2.state, { type: "transfer_joined", id: "a" }).changed).toBe(false);
    const t3 = transition(t2.state, { type: "transfer_completed", id: "a", at: T0 + 9 });
    expect(t3.state.calls["a"]).toMatchObject({ phase: "ended", endReason: "transferred", transfer: null });
    expect(t3.effects).toContainEqual({ type: "media.leave", id: "a" });
  });

  it("warm transfer cancelled (no answer / withdrawn) → back to active with a notice", () => {
    const s = transition(active("a"), { type: "transfer_start", id: "a", mode: "warm", target: agent, at: T0 + 5 }).state;
    const t = transition(s, { type: "transfer_cancelled", id: "a", notice: "Lan did not answer" });
    expect(t.state.calls["a"]).toMatchObject({ phase: "active", transfer: null, notice: "Lan did not answer" });
  });

  it("a transfer started from hold returns to hold when cancelled", () => {
    const held = transition(active("a"), { type: "hold", id: "a" }).state;
    const s = transition(held, { type: "transfer_start", id: "a", mode: "warm", target: agent, at: T0 + 5 }).state;
    expect(transition(s, { type: "transfer_cancelled", id: "a" }).state.calls["a"]?.phase).toBe("held");
  });

  it("blind: the server hands the call over and the room closes → ended, transferred", () => {
    const s = transition(active("a"), { type: "transfer_start", id: "a", mode: "blind", target: agent, at: T0 + 5 }).state;
    const t = transition(s, { type: "remote_end", id: "a", at: T0 + 6 });
    expect(t.state.calls["a"]?.endReason).toBe("transferred");
  });

  it("to a queue is always blind", () => {
    const s = transition(active("a"), { type: "transfer_start", id: "a", mode: "warm", target: { kind: "queue", queueId: "q1", name: "Sales" }, at: T0 + 5 }).state;
    expect(s.calls["a"]?.transfer?.mode).toBe("blind");
    expect(transition(s, { type: "transfer_joined", id: "a" }).changed).toBe(false);
  });

  it("the caller hangs up during a warm transfer → remote_ended", () => {
    const s = transition(active("a"), { type: "transfer_start", id: "a", mode: "warm", target: agent, at: T0 + 5 }).state;
    expect(transition(s, { type: "remote_end", id: "a", at: T0 + 6 }).state.calls["a"]?.endReason).toBe("remote_ended");
  });

  it("no transfer while ringing or connecting", () => {
    expect(transition(ringing("a"), { type: "transfer_start", id: "a", mode: "warm", target: agent, at: T0 }).changed).toBe(false);
    expect(transition(connecting("a"), { type: "transfer_start", id: "a", mode: "warm", target: agent, at: T0 }).changed).toBe(false);
    expect(transition(active("a"), { type: "transfer_completed", id: "a", at: T0 }).changed).toBe(false);
    expect(transition(active("a"), { type: "transfer_cancelled", id: "a" }).changed).toBe(false);
  });

  it("mute still works while transferring", () => {
    const s = transition(active("a"), { type: "transfer_start", id: "a", mode: "warm", target: agent, at: T0 + 5 }).state;
    expect(transition(s, { type: "mute", id: "a", muted: true }).state.calls["a"]?.muted).toBe(true);
  });
});

describe("ended", () => {
  it("ended calls ignore everything but dismiss, which removes them", () => {
    const ended = transition(active("a"), { type: "hang_up", id: "a", at: T0 + 9 }).state;
    for (const e of [
      { type: "hang_up", id: "a", at: T0 }, { type: "remote_end", id: "a", at: T0 }, { type: "hold", id: "a" },
      { type: "mute", id: "a", muted: true }, { type: "decline", id: "a", at: T0 }, { type: "accept", id: "a", at: T0 },
    ] as CallEvent[]) expect(transition(ended, e).changed).toBe(false);
    const t = transition(ended, { type: "dismiss", id: "a" });
    expect(t.state.calls["a"]).toBeUndefined();
    expect(transition(active("b"), { type: "dismiss", id: "b" }).changed).toBe(false);
  });

  it("transition never mutates the state it is given", () => {
    const s = active("a");
    const snapshot = JSON.stringify(s);
    transition(s, { type: "hang_up", id: "a", at: T0 + 9 });
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe("CallStore", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a ring expires on its own clock, and listeners hear the change and effects", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = new CallStore();
    const effects: unknown[] = [];
    const changes: string[] = [];
    store.events.on("effect", (e) => effects.push(e));
    store.events.on("change", (s) => changes.push(Object.values(s.calls).map((c) => c.phase).join(",")));
    store.dispatch({ type: "ring", call: ring("a", { expiresAt: T0 + 5_000 }) });
    expect(changes).toEqual(["ringing"]);
    vi.advanceTimersByTime(4_999);
    expect(store.state.calls["a"]?.phase).toBe("ringing");
    vi.advanceTimersByTime(1);
    expect(store.state.calls["a"]).toMatchObject({ phase: "ended", endReason: "missed" });
    expect(effects).toContainEqual({ type: "ended", id: "a", reason: "missed" });
    store.dispose();
  });

  it("an answered ring does not expire", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = new CallStore();
    store.dispatch({ type: "ring", call: ring("a", { expiresAt: T0 + 5_000 }) });
    store.dispatch({ type: "accept", id: "a" });
    vi.advanceTimersByTime(60_000);
    expect(store.state.calls["a"]?.phase).toBe("connecting");
    store.dispose();
  });

  it("forgets ended calls after forgetEndedAfterMs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = new CallStore({ forgetEndedAfterMs: 3_000 });
    store.dispatch({ type: "ring", call: ring("a:1") });
    store.dispatch({ type: "decline", id: "a:1" });
    expect(store.state.calls["a:1"]?.phase).toBe("ended");
    vi.advanceTimersByTime(3_000);
    expect(store.state.calls["a:1"]).toBeUndefined();
    store.dispose();
  });

  it("effects are emitted even when the state does not change (busy ring)", () => {
    const store = new CallStore({ now: () => T0 });
    store.dispatch({ type: "ring", call: ring("a") });
    store.dispatch({ type: "accept", id: "a" });
    const effects: unknown[] = [];
    store.events.on("effect", (e) => effects.push(e));
    store.dispatch({ type: "ring", call: ring("b") });
    expect(effects).toEqual([{ type: "ring.cancel", id: "b" }]);
    store.dispose();
  });
});
