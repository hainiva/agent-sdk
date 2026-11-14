import { describe, expect, it, vi } from "vitest";
import { HainivaAgentError } from "./errors.js";
import { SessionManager, memoryStore, type AgentSession, type SessionTransport } from "./session.js";
import { createTokenRefresher, singleFlight } from "./singleFlight.js";

const NOW = Date.parse("2026-11-14T00:00:00Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
let n = 0;
const jwt = () => `eyJhbGciOiJFUzI1NiJ9.eyJqdGkiOiJ${++n}xxxx.c2lnbmF0dXJlc2ln`;
const session = (i: number, accessLeftMs = 900_000): AgentSession => ({
  accessToken: `eyJacc${i}aaaa.eyJbbbbbbb.sig${i}`, accessExpiresAt: iso(accessLeftMs),
  refreshToken: `agr_refresh_${i}_zzzzzzzz`, refreshExpiresAt: iso(30 * 86400_000), agentId: "ag1",
});

function setup(over: Partial<SessionTransport> = {}, store = memoryStore()) {
  const getAssertion = vi.fn(async () => jwt());
  let i = 0;
  const transport: SessionTransport = {
    exchange: vi.fn(async () => session(++i)),
    refresh: vi.fn(async () => { const s = session(++i); return { accessToken: s.accessToken, accessExpiresAt: s.accessExpiresAt, refreshToken: s.refreshToken }; }),
    revoke: vi.fn(async () => undefined),
    ...over,
  };
  const m = new SessionManager({ getAssertion, transport, store, now: () => NOW });
  return { m, getAssertion, transport, store };
}

describe("SessionManager", () => {
  it("signs in with a fresh assertion and keeps the session in the store", async () => {
    const { m, getAssertion, transport, store } = setup();
    const s = await m.signIn();
    expect(getAssertion).toHaveBeenCalledTimes(1);
    expect(transport.exchange).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(await store.get())).accessToken).toBe(s.accessToken);
    // The assertion itself is never stored.
    const assertion = await (transport.exchange as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(String(await store.get())).not.toContain(assertion);
  });

  it("calls getAssertion afresh every time a new session is needed (never cached)", async () => {
    const { m, getAssertion, transport } = setup();
    await m.signIn();
    await m.signOut();
    await m.signIn();
    expect(getAssertion).toHaveBeenCalledTimes(2);
    const used = (transport.exchange as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(new Set(used).size).toBe(2);
  });

  it("restores a stored session without a new assertion", async () => {
    const store = memoryStore();
    await store.set(JSON.stringify(session(7)));
    const { m, getAssertion } = setup({}, store);
    expect((await m.signIn()).accessToken).toBe(session(7).accessToken);
    expect(getAssertion).not.toHaveBeenCalled();
  });

  it("drops a corrupt or expired stored session and signs in afresh", async () => {
    for (const bad of ["{not json", JSON.stringify({ accessToken: "x" }), JSON.stringify({ ...session(1), refreshExpiresAt: iso(-1) })]) {
      const store = memoryStore();
      await store.set(bad);
      const { m, getAssertion } = setup({}, store);
      await m.signIn();
      expect(getAssertion).toHaveBeenCalledTimes(1);
    }
  });

  it("refreshes before expiry, once for many concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { m, transport } = setup({
      exchange: vi.fn(async () => session(1, 30_000)), // inside the 60 s skew
      refresh: vi.fn(async () => { await gate; return { accessToken: "eyJnew.eyJnewnew.sig", accessExpiresAt: iso(900_000) }; }),
    });
    await m.signIn().catch(() => undefined);
    const all = Promise.all([m.accessToken(), m.accessToken(), m.accessToken()]);
    release();
    expect(await all).toEqual(["eyJnew.eyJnewnew.sig", "eyJnew.eyJnewnew.sig", "eyJnew.eyJnewnew.sig"]);
    expect(transport.refresh).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces a refresh on the next accessToken()", async () => {
    const { m, transport } = setup();
    await m.signIn();
    await m.accessToken();
    expect(transport.refresh).not.toHaveBeenCalled();
    m.invalidate();
    await m.accessToken();
    expect(transport.refresh).toHaveBeenCalledTimes(1);
  });

  it("a refused refresh (401/403) signs in again with a NEW assertion", async () => {
    const { m, getAssertion } = setup({ refresh: vi.fn(async () => { throw new HainivaAgentError(401, "refresh_reused"); }) });
    await m.signIn();
    m.invalidate();
    await m.accessToken();
    expect(getAssertion).toHaveBeenCalledTimes(2);
  });

  it("a network failure on refresh is thrown (redacted) and retried next time", async () => {
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error("socket hang up while sending agr_refresh_1_zzzzzzzz"))
      .mockResolvedValueOnce({ accessToken: "eyJok.eyJokokok.sig", accessExpiresAt: iso(900_000) });
    const { m } = setup({ refresh });
    await m.signIn();
    m.invalidate();
    const e = await m.accessToken().catch((x) => x);
    expect(e).toBeInstanceOf(HainivaAgentError);
    expect(JSON.stringify(e.body)).not.toContain("agr_refresh_1_zzzzzzzz");
    expect(await m.accessToken()).toBe("eyJok.eyJokokok.sig");
  });

  it("refuses an assertion that is not a JWT, without echoing it", async () => {
    const { m } = setup();
    const bad = new SessionManager({ getAssertion: async () => "my-channel-secret-oops", transport: { exchange: vi.fn(), refresh: vi.fn() } });
    const e = await bad.signIn().catch((x) => x);
    expect(e).toMatchObject({ code: "invalid_assertion" });
    expect(e.message + JSON.stringify(e.body)).not.toContain("my-channel-secret-oops");
    void m;
  });

  it("an exchange error never carries the assertion or tokens", async () => {
    let seen = "";
    const { m } = setup({ exchange: vi.fn(async (a: string) => { seen = a; throw new Error(`upstream rejected ${a}`); }) });
    const e = await m.signIn().catch((x) => x);
    expect(e).toBeInstanceOf(HainivaAgentError);
    expect(e.message + JSON.stringify(e.body)).not.toContain(seen);
  });

  it("signOut revokes on the server, clears the store, and emits a null session", async () => {
    const { m, transport, store } = setup();
    const events: unknown[] = [];
    m.events.on("session", (s) => events.push(s));
    await m.signIn();
    await m.signOut();
    expect(transport.revoke).toHaveBeenCalledTimes(1);
    expect(await store.get()).toBeNull();
    expect(events.at(-1)).toBeNull();
    expect(m.current).toBeNull();
  });

  it("emits token on sign-in and on refresh", async () => {
    const { m } = setup();
    const tokens: string[] = [];
    m.events.on("token", (t) => tokens.push(t));
    await m.signIn();
    m.invalidate();
    await m.accessToken();
    expect(tokens.length).toBe(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("a store that fails does not break sign-in (session stays in memory)", async () => {
    const store = { get: () => { throw new Error("keychain locked"); }, set: async () => { throw new Error("no space"); }, remove: () => undefined };
    const { m } = setup({}, store);
    expect((await m.signIn()).accessToken).toBeTruthy();
  });
});

describe("singleFlight / createTokenRefresher", () => {
  it("singleFlight shares one run among concurrent callers, and runs again afterwards", async () => {
    let runs = 0;
    const f = singleFlight(async () => { runs++; await Promise.resolve(); return runs; });
    expect(await Promise.all([f(), f(), f()])).toEqual([1, 1, 1]);
    expect(await f()).toBe(2);
  });

  it("singleFlight shares the error too, and recovers", async () => {
    let fail = true;
    const f = singleFlight(async () => { if (fail) throw new Error("x"); return "ok"; });
    const r = await Promise.allSettled([f(), f()]);
    expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
    fail = false;
    expect(await f()).toBe("ok");
  });

  it("the refresher refreshes once, caches until the skew, and invalidate() forces it", async () => {
    let now = 0;
    const refresh = vi.fn(async () => ({ token: `t${refresh.mock.calls.length}`, expiresAt: now + 120_000 }));
    const r = createTokenRefresher({ refresh, skewMs: 60_000, now: () => now });
    expect(r.valid).toBe(false);
    expect(await Promise.all([r.get(), r.get()])).toEqual(["t1", "t1"]);
    expect(r.valid).toBe(true);
    now = 59_000;
    expect(await r.get()).toBe("t1");
    now = 61_000;
    expect(await r.get()).toBe("t2");
    r.invalidate();
    expect(await r.get()).toBe("t3");
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("the refresher refuses an empty token", async () => {
    const r = createTokenRefresher({ refresh: async () => ({ token: "", expiresAt: 1e15 }) });
    await expect(r.get()).rejects.toThrow(/no token/);
  });
});
