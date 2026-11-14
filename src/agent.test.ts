/**
 * The `/agent/v1/ws` bindings, the event → call-state mapping and the
 * HainivaAgent facade, against the S2 protocol (api-gateway routes/agentWs.ts):
 * auth first frame, ready {seq}, event {seq, event, data, at},
 * resync_required {fromSeq}, session.expiring, token.refresh, close 4001/4003/4009.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HainivaAgent, type MediaSession } from "./agent.js";
import { agentSocketBindings, ringInfo, toCallEvents, type AgentEventFrame } from "./events.js";
import { initialCallsState, transition } from "./calls.js";
import type { WebSocketLike } from "./ws.js";
import { S2 } from "./__fixtures__/s2.js";

const CALL = "3f1c2b9a-1111-4a2b-8c3d-000000000001";
const CALL2 = "3f1c2b9a-1111-4a2b-8c3d-0000000000c2";
const CONV = "3f1c2b9a-2222-4a2b-8c3d-000000000002";

class FakeWS implements WebSocketLike {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) { FakeWS.all.push(this); }
  open() { this.readyState = 1; this.onopen?.({}); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  push(f: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify({ v: 1, ...f }) }); }
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}
const ws = () => FakeWS.all[FakeWS.all.length - 1]!;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

const ev = (seq: number, event: string, data: Record<string, unknown>): AgentEventFrame => ({ type: "event", seq, event: event as AgentEventFrame["event"], at: new Date().toISOString(), data });

describe("socket bindings", () => {
  it("auth is the first frame; lastSeq rides in it once known; resume is never a separate frame", () => {
    let seq = 0;
    const b = agentSocketBindings(() => seq);
    expect(b.authFrame!("tok")).toEqual({ type: "auth", token: "tok" });
    seq = 41;
    expect(b.authFrame!("tok")).toEqual({ type: "auth", token: "tok", lastSeq: 41 });
    expect(b.resume!(41)).toBeNull();
    expect(b.isReady!({ type: "ready", seq: 3 })).toBe(true);
    expect(b.seqOf!(ev(7, "call.ringing", {}))).toBe(7);
    expect(b.seqOf!({ type: "pong" })).toBeUndefined();
    expect(b.tokenFrame!("t2")).toMatchObject({ type: "token.refresh", token: "t2" });
    expect(b.closeCodes).toEqual({ tokenExpired: 4001, revoked: 4003, fatal: [4009, 1003] });
  });
});

describe("events → call state", () => {
  it("call.ringing becomes a ring; a ring with no known end still ends", () => {
    const now = 1_000_000;
    expect(ringInfo({ callId: CALL, conversationId: CONV, path: "queue", contactName: null, callerNumber: "090****567", expiresAt: null }, now, 60_000))
      .toEqual({ id: CALL, conversationId: CONV, direction: "inbound", path: "queue", from: "090****567", expiresAt: now + 60_000 });
    const t = ringInfo({ callId: CALL, conversationId: CONV, path: "transfer", transferMode: "blind", fromAgentName: "Lan", contactName: null, expiresAt: new Date(now + 30_000).toISOString() }, now, 60_000);
    expect(t).toMatchObject({ path: "transfer", from: "Lan", expiresAt: now + 30_000, transfer: { mode: "blind" } });
    expect(ringInfo({ conversationId: CONV }, now, 1)).toBeNull();
  });

  it("call.ended cancels a ring (with the reason) or ends a live call; a conversation-only end finds its call", () => {
    const now = 5_000;
    let st = transition(initialCallsState, { type: "ring", call: { id: CALL, conversationId: CONV, direction: "inbound", path: "queue", from: "x", expiresAt: now + 10_000 }, at: now }).state;
    expect(toCallEvents(ev(2, "call.ended", { callId: CALL, conversationId: CONV, reason: "answered_elsewhere" }), st, now))
      .toEqual([{ type: "ring_cancelled", id: CALL, reason: "answered_elsewhere", at: now }]);
    expect(toCallEvents(ev(2, "call.ended", { callId: null, conversationId: CONV, reason: "ended" }), st, now))
      .toEqual([{ type: "ring_cancelled", id: CALL, reason: "remote_ended", at: now }]);
    st = transition(st, { type: "accept", id: CALL, at: now }).state;
    st = transition(st, { type: "connected", id: CALL, answered: true, at: now }).state;
    expect(toCallEvents(ev(3, "call.ended", { callId: CALL, conversationId: CONV, reason: "ended" }), st, now)).toEqual([{ type: "remote_end", id: CALL, at: now }]);
    expect(toCallEvents(ev(3, "call.ended", { callId: "unknown", conversationId: null, reason: "ended" }), st, now)).toEqual([]);
    expect(toCallEvents(ev(4, "message.created", { conversationId: CONV }), st, now)).toEqual([]);
  });
});

// ── The facade against a fake gateway ────────────────────────────────────────

function fakeGateway(over: (path: string, init: RequestInit) => { status: number; body?: unknown } | null = () => null) {
  const log: { path: string; method: string; auth?: string; body?: unknown }[] = [];
  let n = 0;
  const fetchFn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const h = (init.headers ?? {}) as Record<string, string>;
    log.push({ path: u.pathname, method: String(init.method), ...(h["authorization"] ? { auth: h["authorization"] } : {}), ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    const o = over(u.pathname, init);
    const r = o ?? (
      u.pathname === "/agent/v1/sessions" ? { status: 201, body: S2.session(++n) }
      : u.pathname === "/agent/v1/sessions/refresh" ? { status: 200, body: S2.session(++n) }
      : u.pathname === "/agent/v1/me" ? { status: 200, body: S2.me }
      : u.pathname === "/agent/v1/rings/pending" ? { status: 200, body: { data: [] } }
      : u.pathname.endsWith("/accept") ? { status: 200, body: { ...S2.accept, callId: u.pathname.split("/")[4] } }
      : u.pathname.endsWith("/end") ? { status: 200, body: { callId: CALL, ended: true } }
      : u.pathname.endsWith("/hold") ? { status: 200, body: { callId: CALL, onHold: true } }
      : u.pathname === "/agent/v1/sessions/current" ? { status: 204 }
      : { status: 404, body: { error: { code: "not_found", message: "nope" } } });
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json" } });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, log };
}

function fakeMedia() {
  const sessions: { leave: ReturnType<typeof vi.fn>; disconnect: () => void; joinedWith: { url: string; token: string } }[] = [];
  const join = vi.fn(async (j: { url: string; token: string }): Promise<MediaSession> => {
    let onDisc: (() => void) | null = null;
    const s = { leave: vi.fn(async () => {}), disconnect: () => onDisc?.(), joinedWith: j };
    sessions.push(s);
    return { leave: s.leave, setMuted: vi.fn(async () => {}), onDisconnected: (fn) => { onDisc = fn; return () => { onDisc = null; }; } };
  });
  return { join, sessions };
}

async function connected(over?: Parameters<typeof fakeGateway>[0], opts: { media?: ReturnType<typeof fakeMedia> } = {}) {
  const gw = fakeGateway(over);
  const getAssertion = vi.fn(async () => "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJzdGFmZi00MiJ9.c2ln");
  const agent = new HainivaAgent({
    baseUrl: "https://api.example.test", tenantId: "tenant-test", getAssertion, fetch: gw.fetchFn, WebSocket: FakeWS,
    ...(opts.media ? { media: opts.media.join } : {}),
  });
  const p = agent.connect();
  await settle();
  ws().open();
  ws().push({ type: "ready", protocol: 1, seq: 10, expiresAt: new Date(Date.now() + 900_000).toISOString() });
  await p;
  return { agent, gw, getAssertion };
}

beforeEach(() => { FakeWS.all = []; });
afterEach(() => { vi.useRealTimers(); });

describe("HainivaAgent", () => {
  it("connect: signs in, loads me, opens the socket with the token in the FIRST FRAME (not the URL)", async () => {
    const { agent, gw } = await connected();
    expect(agent.me?.id).toBe(S2.me.id);
    expect(ws().url).toBe("wss://api.example.test/agent/v1/ws");
    expect(ws().sent[0]).toEqual({ type: "auth", token: S2.session(1).accessToken });
    expect(gw.log.map((l) => l.path)).toEqual(["/agent/v1/sessions", "/agent/v1/me", "/agent/v1/rings/pending"]);
    expect(agent.connection).toBe("open");
  });

  it("a call.ringing event reaches the app and the call state; call.ended cancels it", async () => {
    const { agent } = await connected();
    const rings: unknown[] = []; const effects: unknown[] = [];
    agent.on("call.ringing", (r) => rings.push(r));
    agent.on("callEffect", (e) => effects.push(e));
    ws().push(ev(11, "call.ringing", { callId: CALL, conversationId: CONV, path: "direct", contactName: "Khách", expiresAt: null }) as unknown as Record<string, unknown>);
    expect(rings).toHaveLength(1);
    expect(agent.callsState.calls[CALL]?.phase).toBe("ringing");
    ws().push(ev(11, "call.ringing", { callId: CALL2, conversationId: CONV, path: "direct", contactName: "dup", expiresAt: null }) as unknown as Record<string, unknown>);
    expect(rings).toHaveLength(1); // same seq again: dropped
    ws().push(ev(12, "call.ended", { callId: CALL, conversationId: CONV, reason: "answered_elsewhere" }) as unknown as Record<string, unknown>);
    expect(agent.callsState.calls[CALL]).toMatchObject({ phase: "ended", endReason: "answered_elsewhere" });
    expect(effects).toContainEqual({ type: "ring.cancel", id: CALL });
  });

  it("accept → joins media with the room credentials; the room closing ends the call; end leaves media", async () => {
    const media = fakeMedia();
    const { agent } = await connected(undefined, { media });
    ws().push(ev(11, "call.ringing", { callId: CALL, conversationId: CONV, path: "queue", contactName: "K", expiresAt: null }) as unknown as Record<string, unknown>);
    const r = await agent.calls.accept(CALL);
    expect(r.accepted.media?.roomName).toBe("room-1");
    expect(media.sessions[0]!.joinedWith).toEqual({ url: "wss://lk.example.test", token: S2.accept.media.token });
    expect(agent.callsState.calls[CALL]?.phase).toBe("active");
    media.sessions[0]!.disconnect();
    expect(agent.callsState.calls[CALL]).toMatchObject({ phase: "ended", endReason: "remote_ended" });

    ws().push(ev(12, "call.ringing", { callId: CALL2, conversationId: CONV, path: "direct", contactName: "K2", expiresAt: null }) as unknown as Record<string, unknown>);
    await agent.calls.accept(CALL2);
    await agent.calls.end(CALL2);
    expect(media.sessions[1]!.leave).toHaveBeenCalled();
    expect(agent.callsState.calls[CALL2]).toMatchObject({ phase: "ended", endReason: "hung_up" });
  });

  it("answering from a push (the socket never saw the ring) still joins media and stays in the call", async () => {
    const media = fakeMedia();
    const { agent } = await connected(undefined, { media });
    await agent.calls.accept(CALL, { from: "Khách" });
    expect(media.sessions).toHaveLength(1);
    expect(media.sessions[0]!.leave).not.toHaveBeenCalled();
    expect(agent.callsState.calls[CALL]).toMatchObject({ phase: "active", info: { from: "Khách" } });
  });

  it("accept refused 409 (someone was faster) ends the ring as answered elsewhere", async () => {
    const { agent } = await connected((p) => (p.endsWith("/accept") ? { status: 409, body: { error: { code: "already_answered", message: "taken" } } } : null));
    ws().push(ev(11, "call.ringing", { callId: CALL, conversationId: CONV, path: "queue", contactName: "K", expiresAt: null }) as unknown as Record<string, unknown>);
    await expect(agent.calls.accept(CALL)).rejects.toMatchObject({ status: 409 });
    expect(agent.callsState.calls[CALL]).toMatchObject({ phase: "ended", endReason: "answered_elsewhere" });
  });

  it("resync_required: rewinds to fromSeq, refetches pending rings into the call state, tells the app", async () => {
    let pending: unknown[] = [];
    const { agent, gw } = await connected((p) => (p === "/agent/v1/rings/pending" ? { status: 200, body: { data: pending } } : null));
    const resyncs: unknown[] = [];
    agent.on("resync", (r) => resyncs.push(r));
    pending = S2.rings.data;
    ws().push({ type: "resync_required", fromSeq: 3 });
    await settle();
    expect(resyncs).toEqual([{ fromSeq: 3 }]);
    expect(gw.log.filter((l) => l.path === "/agent/v1/rings/pending")).toHaveLength(2);
    expect(agent.callsState.calls[CALL]?.phase).toBe("ringing");
    // The next event at seq 4 is delivered (the position was rewound from 10).
    const got: unknown[] = [];
    agent.on("message.created", (m) => got.push(m));
    ws().push(ev(4, "message.created", { conversationId: CONV, preview: "hi" }) as unknown as Record<string, unknown>);
    expect(got).toHaveLength(1);
  });

  it("reconnects with lastSeq in the auth frame (the server replays atomically)", async () => {
    const { agent } = await connected();
    ws().push(ev(15, "message.created", { conversationId: CONV }) as unknown as Record<string, unknown>);
    const first = ws();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    first.drop(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await settle();
    expect(ws()).not.toBe(first);
    ws().open();
    expect(ws().sent[0]).toMatchObject({ type: "auth", lastSeq: 15 });
    void agent;
  });

  it("session.expiring refreshes the token and hands it to the open socket (token.refresh)", async () => {
    const { agent, gw } = await connected((p) => (p === "/agent/v1/sessions" ? { status: 201, body: { ...S2.session(1), accessExpiresAt: new Date(Date.now() + 30_000).toISOString() } } : null));
    ws().push({ type: "session.expiring", expiresAt: new Date(Date.now() + 30_000).toISOString() });
    await settle();
    expect(gw.log.some((l) => l.path === "/agent/v1/sessions/refresh")).toBe(true);
    const tf = ws().sent.find((f) => f["type"] === "token.refresh");
    expect(tf).toMatchObject({ type: "token.refresh", token: agent.session.current!.accessToken });
  });

  it("socket closed 4003 (revoked): no reconnect, the session is forgotten, the app is told", async () => {
    const { agent } = await connected();
    const revoked: unknown[] = [];
    agent.on("revoked", (r) => revoked.push(r));
    const n = FakeWS.all.length;
    ws().drop(4003);
    await settle();
    expect(revoked).toEqual([{ reason: "socket_revoked" }]);
    expect(agent.session.current).toBeNull();
    expect(FakeWS.all.length).toBe(n);
  });

  it("socket closed 4009 (too many sockets): stops and reports, does not hammer the server", async () => {
    const { agent } = await connected();
    const errors: string[] = [];
    agent.on("error", (e) => errors.push(e.code));
    const n = FakeWS.all.length;
    ws().drop(4009);
    await settle();
    expect(errors).toEqual(["socket_closed_4009"]);
    expect(FakeWS.all.length).toBe(n);
    expect(agent.connection).toBe("closed");
  });

  it("a REST 401 session_revoked forgets the session and emits revoked", async () => {
    const { agent } = await connected((p) => (p === "/agent/v1/me/status" ? { status: 401, body: S2.errors.revoked } : null));
    const revoked: unknown[] = [];
    agent.on("revoked", (r) => revoked.push(r));
    await expect(agent.setStatus("away")).rejects.toMatchObject({ code: "session_revoked" });
    expect(revoked).toEqual([{ reason: "session_revoked" }]);
    expect(agent.session.current).toBeNull();
  });

  it("disconnect({signOut}) leaves media, closes the socket and revokes the session on the server", async () => {
    const media = fakeMedia();
    const { agent, gw } = await connected(undefined, { media });
    ws().push(ev(11, "call.ringing", { callId: CALL, conversationId: CONV, path: "queue", contactName: "K", expiresAt: null }) as unknown as Record<string, unknown>);
    await agent.calls.accept(CALL);
    await agent.disconnect({ signOut: true });
    expect(media.sessions[0]!.leave).toHaveBeenCalled();
    expect(gw.log.at(-1)).toMatchObject({ path: "/agent/v1/sessions/current", method: "DELETE" });
    expect(agent.session.current).toBeNull();
  });

  it("unknown event names are passed on as event.unknown (a newer server)", async () => {
    const { agent } = await connected();
    const got: unknown[] = [];
    agent.on("event.unknown", (f) => got.push(f));
    ws().push({ type: "event", seq: 11, event: "queue.stats", at: "x", data: {} });
    expect(got).toHaveLength(1);
  });
});
