/**
 * @hainiva/agent-sdk/embed — mountDesk and the React Native bridge script.
 *   - the iframe: /embed?app=<id> only (no token in the URL), sandbox + allow;
 *   - only messages from THIS iframe's window AND the desk origin are read,
 *     only in the exact protocol shapes;
 *   - everything we send goes to the desk origin, never "*";
 *   - ready → a desk token from agent.desk.session(); token-request → a new
 *     one (single flight); a refused session → onEnded + the desk told;
 *   - no ready in time → onEnded("load_failed"); destroy() tells the desk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DESK_ALLOW, DESK_SANDBOX, DeskHost, deskUrl, mountDesk, parseDeskMessage, type HostToDesk } from "./embed.js";
import { deskBridgeScript, deliverScript } from "./reactNativeDesk.js";
import { HainivaAgentError } from "./errors.js";

const APP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DESK = "https://app.hainiva.com";

type Listener = (e: { source: unknown; origin: string; data: unknown }) => void;

function fakeDom() {
  const listeners: Listener[] = [];
  const toDesk: { msg: unknown; origin: string }[] = [];
  const contentWindow = { postMessage: (msg: unknown, origin: string) => { if (origin === "*") throw new Error("never *"); toDesk.push({ msg, origin }); } };
  const attrs: Record<string, string> = {};
  const iframe = {
    contentWindow, style: {} as Record<string, string>, removed: false,
    setAttribute: (k: string, v: string) => { attrs[k] = v; },
    remove() { this.removed = true; },
  };
  const win = {
    location: { origin: "https://staff.partner.vn" },
    addEventListener: (t: string, fn: Listener) => { if (t === "message") listeners.push(fn); },
    removeEventListener: (_t: string, fn: Listener) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
  };
  const doc = { defaultView: win, createElement: () => iframe };
  const container = { ownerDocument: doc, children: [] as unknown[], appendChild(n: unknown) { this.children.push(n); return n; } };
  const fromDesk = (data: unknown, origin = DESK, source: unknown = contentWindow) => listeners.forEach((l) => l({ source, origin, data }));
  return { container, iframe, attrs, toDesk, fromDesk, listeners };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const tokenOf = (n: number) => ({ token: `h.p${n}.s`, expiresAt: "2026-11-14T10:15:00.000Z" });

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("the iframe", () => {
  it("/embed?app=<id> only, sandboxed, microphone delegated, appended", () => {
    const d = fakeDom();
    const agent = { desk: { session: vi.fn(async () => tokenOf(1)) } };
    const m = mountDesk(d.container as never, { agent, appId: APP.toUpperCase(), baseUrl: `${DESK}/whatever?x=1` });
    expect(d.attrs["src"]).toBe(`${DESK}/embed?app=${APP}`);
    expect(d.attrs["sandbox"]).toBe(DESK_SANDBOX);
    expect(DESK_SANDBOX).not.toMatch(/top-navigation/);
    expect(d.attrs["allow"]).toBe(DESK_ALLOW);
    expect(DESK_ALLOW).toMatch(/microphone/);
    expect(d.container.children).toEqual([d.iframe]);
    expect(agent.desk.session).not.toHaveBeenCalled();
    m.destroy();
  });

  it("refuses a bad app id, an http desk, credentials in the URL, and a host on the desk's own origin", () => {
    const agent = { desk: { session: async () => tokenOf(1) } };
    expect(() => mountDesk(fakeDom().container as never, { agent, appId: "x", baseUrl: DESK })).toThrow(HainivaAgentError);
    expect(() => mountDesk(fakeDom().container as never, { agent, appId: APP, baseUrl: "http://app.hainiva.com" })).toThrow(HainivaAgentError);
    expect(() => mountDesk(fakeDom().container as never, { agent, appId: APP, baseUrl: `${DESK}/?token=abc` })).toThrow(HainivaAgentError);
    const d = fakeDom();
    (d.container.ownerDocument.defaultView.location as { origin: string }).origin = DESK;
    expect(() => mountDesk(d.container as never, { agent, appId: APP, baseUrl: DESK })).toThrow(HainivaAgentError);
    expect(deskUrl("http://localhost:3000", APP, { allowInsecureLocalhost: true }).href).toBe(`http://localhost:3000/embed?app=${APP}`);
  });
});

describe("handshake", () => {
  it("ready → a desk token to the desk origin only; theme/locale follow; token-request → a fresh one", async () => {
    const d = fakeDom();
    let n = 0;
    const agent = { desk: { session: vi.fn(async () => tokenOf(++n)) } };
    mountDesk(d.container as never, { agent, appId: APP, baseUrl: DESK, theme: "dark", locale: "vi" });
    d.fromDesk({ v: 1, type: "hainiva:ready", appId: APP });
    await flush();
    expect(d.toDesk).toEqual([
      { msg: { v: 1, type: "hainiva:theme", mode: "dark" }, origin: DESK },
      { msg: { v: 1, type: "hainiva:locale", locale: "vi" }, origin: DESK },
      { msg: { v: 1, type: "hainiva:token", ...tokenOf(1) }, origin: DESK },
    ]);
    d.fromDesk({ v: 1, type: "hainiva:token-request", reason: "expiring" });
    d.fromDesk({ v: 1, type: "hainiva:token-request", reason: "expiring" });
    await flush();
    expect(agent.desk.session).toHaveBeenCalledTimes(2); // single flight
    expect(d.toDesk.at(-1)).toEqual({ msg: { v: 1, type: "hainiva:token", ...tokenOf(2) }, origin: DESK });
  });

  it("ignores another source, another origin, malformed or unknown messages, and a ready for another app", async () => {
    const d = fakeDom();
    const agent = { desk: { session: vi.fn(async () => tokenOf(1)) } };
    const onDial = vi.fn();
    mountDesk(d.container as never, { agent, appId: APP, baseUrl: DESK, onDial });
    d.fromDesk({ v: 1, type: "hainiva:ready", appId: APP }, "https://evil.example");
    d.fromDesk({ v: 1, type: "hainiva:ready", appId: APP }, DESK, { postMessage() {} });
    d.fromDesk({ v: 1, type: "hainiva:ready", appId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    d.fromDesk({ v: 1, type: "hainiva:ready", appId: APP, token: "x" });
    d.fromDesk({ v: 1, type: "hainiva:dial", number: "<script>" });
    d.fromDesk("not json");
    await flush();
    expect(agent.desk.session).not.toHaveBeenCalled();
    expect(onDial).not.toHaveBeenCalled();
    expect(d.toDesk).toEqual([]);
  });

  it("dial / dialer / open-url / media-error reach the callbacks", () => {
    const d = fakeDom();
    const cb = { onDial: vi.fn(), onDialer: vi.fn(), onOpenUrl: vi.fn(), onMediaError: vi.fn() };
    mountDesk(d.container as never, { agent: { desk: { session: async () => tokenOf(1) } }, appId: APP, baseUrl: DESK, ...cb });
    d.fromDesk({ v: 1, type: "hainiva:dial", number: "0901 234 567", contactId: APP });
    d.fromDesk({ v: 1, type: "hainiva:dialer" });
    d.fromDesk({ v: 1, type: "hainiva:open-url", url: "https://hainiva.com/huong-dan" });
    d.fromDesk({ v: 1, type: "hainiva:open-url", url: "javascript:alert(1)" });
    d.fromDesk({ v: 1, type: "hainiva:media-error", name: "NotAllowedError" });
    expect(cb.onDial).toHaveBeenCalledWith("0901 234 567", APP);
    expect(cb.onDialer).toHaveBeenCalledWith({});
    expect(cb.onOpenUrl).toHaveBeenCalledTimes(1);
    expect(cb.onMediaError).toHaveBeenCalledWith("NotAllowedError");
  });

  it("a refused agent session ends the desk (it is told), a transient error does not", async () => {
    const d = fakeDom();
    const onEnded = vi.fn();
    const session = vi.fn()
      .mockRejectedValueOnce(new HainivaAgentError(503, "unavailable", {}))
      .mockRejectedValueOnce(new HainivaAgentError(401, "session_revoked", {}));
    mountDesk(d.container as never, { agent: { desk: { session } }, appId: APP, baseUrl: DESK, onEnded });
    d.fromDesk({ v: 1, type: "hainiva:ready", appId: APP });
    await flush();
    expect(onEnded).not.toHaveBeenCalled();
    d.fromDesk({ v: 1, type: "hainiva:token-request", reason: "unauthorized" });
    await flush();
    expect(onEnded).toHaveBeenCalledWith("session_ended");
    expect(d.toDesk.at(-1)).toEqual({ msg: { v: 1, type: "hainiva:end" }, origin: DESK });
  });

  it("the desk ending (revoked) reaches onEnded once", () => {
    const d = fakeDom();
    const onEnded = vi.fn();
    mountDesk(d.container as never, { agent: { desk: { session: async () => tokenOf(1) } }, appId: APP, baseUrl: DESK, onEnded });
    d.fromDesk({ v: 1, type: "hainiva:ready", appId: APP });
    d.fromDesk({ v: 1, type: "hainiva:ended", reason: "revoked" });
    d.fromDesk({ v: 1, type: "hainiva:ended", reason: "expired" });
    expect(onEnded.mock.calls).toEqual([["revoked"]]);
  });

  it("no ready in time = load_failed (e.g. this origin is not allowed: the CSP blocked the frame)", () => {
    const d = fakeDom();
    const onEnded = vi.fn();
    mountDesk(d.container as never, { agent: { desk: { session: async () => tokenOf(1) } }, appId: APP, baseUrl: DESK, onEnded, loadTimeoutMs: 5_000 });
    vi.advanceTimersByTime(5_001);
    expect(onEnded).toHaveBeenCalledWith("load_failed");
  });

  it("destroy() tells the desk to drop its token, removes the frame and the listener", () => {
    const d = fakeDom();
    const m = mountDesk(d.container as never, { agent: { desk: { session: async () => tokenOf(1) } }, appId: APP, baseUrl: DESK });
    m.destroy();
    expect(d.toDesk).toEqual([{ msg: { v: 1, type: "hainiva:end" }, origin: DESK }]);
    expect(d.iframe.removed).toBe(true);
    expect(d.listeners).toHaveLength(0);
  });
});

describe("protocol parsing", () => {
  it("exact shapes only", () => {
    expect(parseDeskMessage({ v: 1, type: "hainiva:ready", appId: APP })).toBeTruthy();
    for (const bad of [null, [], { v: 2, type: "hainiva:ready", appId: APP }, { v: 1, type: "hainiva:ended", reason: "whatever" },
      { v: 1, type: "hainiva:dialer", number: "1", extra: 1 }, { v: 1, type: "hainiva:dial", number: "1", contactId: "x" }, "x".repeat(9000)]) {
      expect(parseDeskMessage(bad)).toBeNull();
    }
  });
});

describe("React Native bridge", () => {
  it("the injected bridge installs only on the desk origin; messages go in as a JSON string literal", () => {
    const s = deskBridgeScript(DESK, APP);
    expect(s).toContain(`location.origin!==${JSON.stringify(DESK)}`);
    expect(s).toContain('host:"partner-rn"');
    const w = { location: { origin: "https://evil.example" } } as { location: { origin: string }; __HAINIVA_EMBED__?: unknown };
    new Function("window", "location", s)(w, w.location);
    expect(w.__HAINIVA_EMBED__).toBeUndefined();
    const ok = { location: { origin: DESK } } as { location: { origin: string }; __HAINIVA_EMBED__?: { q: string[]; deliver(s: string): void } };
    new Function("window", "location", s)(ok, ok.location);
    const evil: HostToDesk = { v: 1, type: "hainiva:token", token: `");alert(1);("`, expiresAt: "x" };
    new Function("window", deliverScript(evil))(ok);
    expect(JSON.parse(ok.__HAINIVA_EMBED__!.q[0]!)).toEqual(evil);
  });

  it("DeskHost is transport-agnostic (the RN component drives the same one)", async () => {
    const sent: HostToDesk[] = [];
    const h = new DeskHost(APP, { desk: { session: async () => tokenOf(7) } }, (m) => sent.push(m), {});
    h.receive(JSON.stringify({ v: 1, type: "hainiva:ready", appId: APP }));
    await flush();
    expect(sent).toEqual([{ v: 1, type: "hainiva:token", ...tokenOf(7) }]);
  });
});
