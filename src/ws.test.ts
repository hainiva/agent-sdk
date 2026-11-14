import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconnectingSocket, backoffDelay, type SocketOptions, type WebSocketLike } from "./ws.js";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzaWQiOiJzMSJ9.c2ln";

/** A fake socket the test drives. */
class FakeWS implements WebSocketLike {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) { FakeWS.all.push(this); }
  open() { this.readyState = 1; this.onopen?.({}); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close(code = 1000) { this.closedWith = code; this.readyState = 3; this.onclose?.({ code }); }
  push(f: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(f) }); }
  /** The server closes. */
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}
const last = () => FakeWS.all[FakeWS.all.length - 1]!;
/** Let the async open() (getToken) settle. */
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function make(over: Partial<SocketOptions> = {}) {
  const getToken = vi.fn(async () => TOKEN);
  const s = new ReconnectingSocket({
    url: "wss://api.hainiva.com/agent/v1/ws",
    getToken,
    WebSocket: FakeWS,
    backoff: { initialMs: 1000, maxMs: 8000, random: () => 1 },
    resume: (lastSeq) => ({ type: "resume", lastSeq }),
    ...over,
  });
  const states: string[] = [];
  s.events.on("state", (x) => states.push(x));
  return { s, getToken, states };
}

async function openReady(s: ReconnectingSocket) {
  s.connect();
  await settle();
  last().open();
  last().push({ type: "ready" });
}

beforeEach(() => { FakeWS.all = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("backoffDelay", () => {
  it("grows exponentially up to the cap, with jitter in the upper half", () => {
    expect(backoffDelay(0, 1000, 30000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 30000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 30000, () => 1)).toBe(8000);
    expect(backoffDelay(20, 1000, 30000, () => 1)).toBe(30000);
    for (let i = 0; i < 50; i++) { const d = backoffDelay(4, 1000, 30000); expect(d).toBeGreaterThanOrEqual(8000); expect(d).toBeLessThanOrEqual(16000); }
  });
});

describe("ReconnectingSocket", () => {
  it("authenticates in the FIRST frame; the token is never in the URL", async () => {
    const { s, states } = make();
    s.connect();
    await settle();
    const ws = last();
    expect(ws.url).toBe("wss://api.hainiva.com/agent/v1/ws");
    expect(ws.url).not.toContain(TOKEN);
    ws.open();
    expect(ws.sent).toEqual([{ type: "auth", token: TOKEN }]);
    expect(s.send({ type: "x" })).toBe(false); // nothing else before ready
    ws.push({ type: "ready" });
    expect(s.state).toBe("open");
    expect(states).toEqual(["connecting", "open"]);
    expect(s.send({ type: "x" })).toBe(true);
  });

  it("delivers frames only after ready, and drops replayed ones (seq ≤ lastSeq)", async () => {
    const { s } = make();
    const got: unknown[] = [];
    s.events.on("frame", (f) => got.push(f));
    s.connect();
    await settle();
    last().open();
    last().push({ type: "event", seq: 1 }); // before ready: not delivered
    last().push({ type: "ready" });
    last().push({ type: "event", seq: 1 });
    last().push({ type: "event", seq: 2 });
    last().push({ type: "event", seq: 2 });
    last().push({ type: "pong" });
    expect(got).toEqual([{ type: "event", seq: 1 }, { type: "event", seq: 2 }, { type: "pong" }]);
    expect(s.lastSeq).toBe(2);
  });

  it("reconnects with backoff and resumes from lastSeq", async () => {
    const { s, getToken } = make();
    await openReady(s);
    last().push({ type: "event", seq: 41 });
    last().push({ type: "event", seq: 42 });
    last().drop(1006);
    expect(s.state).toBe("reconnecting");
    vi.advanceTimersByTime(999);
    expect(FakeWS.all.length).toBe(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(FakeWS.all.length).toBe(2);
    expect(getToken).toHaveBeenCalledTimes(2); // a fresh token for every connection
    last().open();
    last().push({ type: "ready" });
    expect(last().sent).toEqual([{ type: "auth", token: TOKEN }, { type: "resume", lastSeq: 42 }]);
  });

  it("no resume frame on the first connection", async () => {
    const { s } = make();
    await openReady(s);
    expect(last().sent).toEqual([{ type: "auth", token: TOKEN }]);
  });

  it("setLastSeq restores a persisted position for the first resume", async () => {
    const { s } = make();
    s.setLastSeq(100);
    await openReady(s);
    expect(last().sent[1]).toEqual({ type: "resume", lastSeq: 100 });
  });

  it("backoff grows while it keeps failing and resets after a ready", async () => {
    const { s } = make();
    s.connect();
    await settle();
    last().drop(1006);                       // attempt 0 → 1000 ms
    vi.advanceTimersByTime(1000); await settle();
    last().drop(1006);                       // attempt 1 → 2000 ms
    vi.advanceTimersByTime(1999); await settle();
    expect(FakeWS.all.length).toBe(2);
    vi.advanceTimersByTime(1); await settle();
    expect(FakeWS.all.length).toBe(3);
    last().open(); last().push({ type: "ready" });
    last().drop(1006);                       // reset → 1000 ms again
    vi.advanceTimersByTime(1000); await settle();
    expect(FakeWS.all.length).toBe(4);
  });

  it("4001 (token expired): tells the session, then reconnects with a new token", async () => {
    const onTokenRejected = vi.fn();
    const { s } = make({ onTokenRejected });
    await openReady(s);
    last().drop(4001);
    expect(onTokenRejected).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000); await settle();
    expect(FakeWS.all.length).toBe(2);
  });

  it("4003 (revoked): stops for good and says so", async () => {
    const { s } = make();
    const revoked = vi.fn();
    s.events.on("revoked", revoked);
    await openReady(s);
    last().drop(4003);
    vi.advanceTimersByTime(60_000); await settle();
    expect(revoked).toHaveBeenCalledWith({ code: 4003 });
    expect(s.state).toBe("closed");
    expect(FakeWS.all.length).toBe(1);
  });

  it("closes a socket that never becomes ready (auth timeout) and retries", async () => {
    const { s } = make({ authTimeoutMs: 5000 });
    s.connect();
    await settle();
    last().open();
    vi.advanceTimersByTime(5000);
    expect(FakeWS.all[0]!.closedWith).toBe(4000);
    vi.advanceTimersByTime(1000); await settle();
    expect(FakeWS.all.length).toBe(2);
  });

  it("heartbeat: pings, and reconnects when nothing arrives within the timeout", async () => {
    const { s } = make({ heartbeat: { intervalMs: 10_000, timeoutMs: 25_000 } });
    await openReady(s);
    vi.advanceTimersByTime(10_000);
    expect(last().sent.at(-1)).toEqual({ type: "ping" });
    last().push({ type: "pong" });            // alive
    vi.advanceTimersByTime(20_000);
    expect(FakeWS.all[0]!.closedWith).toBeNull();
    vi.advanceTimersByTime(10_000);           // 30 s of silence
    expect(FakeWS.all[0]!.closedWith).toBe(4000);
    vi.advanceTimersByTime(1000); await settle();
    expect(FakeWS.all.length).toBe(2);
  });

  it("disconnect() closes and does not reconnect", async () => {
    const { s } = make();
    await openReady(s);
    s.disconnect();
    vi.advanceTimersByTime(60_000); await settle();
    expect(s.state).toBe("closed");
    expect(FakeWS.all.length).toBe(1);
  });

  it("refuses a URL that is not wss:// or carries a credential, and does not retry", async () => {
    for (const url of ["ws://api.hainiva.com/ws", `wss://api.hainiva.com/ws?token=${TOKEN}`, "wss://api.hainiva.com/ws?access_token=x"]) {
      FakeWS.all = [];
      const { s } = make({ url });
      const errors: string[] = [];
      s.events.on("error", (e) => errors.push(e.code));
      s.connect();
      await settle();
      vi.advanceTimersByTime(60_000); await settle();
      expect(FakeWS.all.length, url).toBe(0);
      expect(errors[0]).toMatch(/insecure_url|credentials_in_url/);
      expect(s.state).toBe("closed");
    }
  });

  it("refuses a URL that contains the current (opaque) token", async () => {
    const { s } = make({ url: "wss://api.hainiva.com/ws/opaque123456", getToken: async () => "opaque123456" });
    const errors: string[] = [];
    s.events.on("error", (e) => errors.push(e.code));
    s.connect();
    await settle();
    expect(FakeWS.all.length).toBe(0);
    expect(errors).toEqual(["credentials_in_url"]);
  });

  it("a getToken failure is reported (redacted) and retried with backoff", async () => {
    let fail = true;
    const { s } = make({ getToken: async () => { if (fail) throw new Error(`refresh failed for ${TOKEN}`); return TOKEN; } });
    const errors: string[] = [];
    s.events.on("error", (e) => errors.push(JSON.stringify(e.body) + e.message));
    s.connect();
    await settle();
    expect(errors.length).toBe(1);
    expect(errors[0]).not.toContain(TOKEN);
    fail = false;
    vi.advanceTimersByTime(1000); await settle();
    expect(FakeWS.all.length).toBe(1);
  });

  it("logs never contain the token", async () => {
    const log = vi.fn();
    const { s } = make({ log });
    await openReady(s);
    last().drop(4001);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });

  it("custom protocol hooks: authFrame, isReady, seqOf, tokenFrame, decode/encode", async () => {
    const { s } = make({
      authFrame: (t) => ({ op: "hello", credential: t }),
      isReady: (f) => f["op"] === "welcome",
      seqOf: (f) => (typeof f["n"] === "number" ? f["n"] : undefined),
      tokenFrame: (t) => ({ op: "rekey", credential: t }),
    });
    const got: unknown[] = [];
    s.events.on("frame", (f) => got.push(f));
    s.connect();
    await settle();
    last().open();
    expect(last().sent[0]).toEqual({ op: "hello", credential: TOKEN });
    last().push({ type: "ready" }); // not this protocol's ready
    expect(s.state).not.toBe("open");
    last().push({ op: "welcome" });
    expect(s.state).toBe("open");
    last().push({ op: "msg", n: 5 });
    last().push({ op: "msg", n: 5 });
    expect(got).toEqual([{ op: "msg", n: 5 }]);
    expect(s.updateToken("eyJnew.eyJnewtok.sig")).toBe(true);
    expect(last().sent.at(-1)).toEqual({ op: "rekey", credential: "eyJnew.eyJnewtok.sig" });
  });

  it("ignores frames that are not valid JSON", async () => {
    const { s } = make();
    await openReady(s);
    expect(() => last().onmessage?.({ data: "not json" })).not.toThrow();
  });
});
