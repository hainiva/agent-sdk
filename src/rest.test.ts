/**
 * Contract tests for the REST client against the S2 response shapes
 * (api-gateway routes/agentPublic.ts + agentFacade.ts, as exercised by
 * scripts/partner-platform/s2-e2e.sh on staging). The fixtures below are those
 * shapes; a change to them is a change of the public contract.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentRestClient, errorFromResponse, newIdempotencyKey } from "./rest.js";
import { SessionManager } from "./session.js";
import { HainivaAgentError } from "./errors.js";

import { APP, BASE, CALL, CONV, MEMBER, S2, T, future, jwt } from "./__fixtures__/s2.js";
void APP;

type Handler = (url: URL, init: RequestInit & { headers: Record<string, string> }) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;

function fakeFetch(handler: Handler) {
  const calls: { url: URL; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: String(init.method), headers, body });
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const r = await handler(url, { ...init, headers });
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(r.status === 204 ? null : text, { status: r.status, headers: r.headers ?? { "content-type": "application/json" } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

/** A client + session wired the way HainivaAgent wires them. */
function wired(handler: Handler, getAssertion = vi.fn(async () => jwt(0))) {
  const f = fakeFetch(handler);
  const rest = new AgentRestClient({ baseUrl: BASE, tenantId: T, fetch: f.fn, device: { label: "test", platform: "web" } });
  const session = new SessionManager({ getAssertion, transport: rest.sessions });
  rest.useTokens(session);
  return { rest, session, ...f, getAssertion };
}

describe("sign-in and refresh (the SessionManager transport)", () => {
  it("signs in with {tenantId, assertion, device}, no Authorization header, and keeps the session", async () => {
    const { session, calls } = wired((u) => (u.pathname === "/agent/v1/sessions" ? { status: 201, body: S2.session(1) } : { status: 404 }));
    const s = await session.signIn();
    expect(s.member.role).toBe("agent");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ tenantId: T, assertion: jwt(0), device: { label: "test", platform: "web" } });
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    expect(calls[0]!.url.search).toBe("");
  });

  it("refresh sends {tenantId, refreshToken}; sign-out is DELETE /sessions/current with the access token", async () => {
    let n = 1;
    const { session, calls } = wired((u) => {
      if (u.pathname === "/agent/v1/sessions") return { status: 201, body: { ...S2.session(1), accessExpiresAt: future(10) } };
      if (u.pathname === "/agent/v1/sessions/refresh") return { status: 200, body: S2.session(++n) };
      if (u.pathname === "/agent/v1/sessions/current") return { status: 204 };
      return { status: 404 };
    });
    await session.signIn();
    await session.accessToken(); // 10 s left < 60 s skew: refreshes
    const r = calls.find((c) => c.url.pathname.endsWith("/refresh"))!;
    expect(r.body).toEqual({ tenantId: T, refreshToken: S2.session(1).refreshToken });
    await session.signOut();
    const d = calls.find((c) => c.method === "DELETE")!;
    expect(d.url.pathname).toBe("/agent/v1/sessions/current");
    expect(d.headers["authorization"]).toBe(`Bearer ${jwt(2)}`);
  });
});

describe("authenticated requests", () => {
  it("send the token in the Authorization header only — never in the URL", async () => {
    const { rest, session, calls } = wired((u) => (u.pathname === "/agent/v1/sessions" ? { status: 201, body: S2.session(1) } : { status: 200, body: S2.me }));
    await session.signIn();
    const me = await rest.me();
    expect(me.id).toBe(MEMBER);
    const c = calls[1]!;
    expect(c.headers["authorization"]).toBe(`Bearer ${jwt(1)}`);
    expect(c.url.toString()).not.toContain(jwt(1));
    expect(c.headers["idempotency-key"]).toBeUndefined();
  });

  it("POSTs carry an Idempotency-Key (a v4 UUID); bodies are the S2 contract", async () => {
    const { rest, session, calls } = wired((u) => {
      if (u.pathname === "/agent/v1/sessions") return { status: 201, body: S2.session(1) };
      if (u.pathname.endsWith("/accept")) return { status: 200, body: S2.accept };
      if (u.pathname.endsWith("/transfer")) return { status: 200, body: { callId: CALL, transferred: true } };
      if (u.pathname.endsWith("/hold")) return { status: 200, body: { callId: CALL, onHold: true } };
      if (u.pathname.endsWith("/wrapup")) return { status: 200, body: { callId: CALL, wrappedUp: true } };
      if (u.pathname.endsWith("/status")) return { status: 200, body: S2.status };
      return { status: 404 };
    });
    await session.signIn();
    const a = await rest.acceptCall(CALL);
    expect(a.media?.livekitUrl).toBe("wss://lk.example.test");
    await rest.transferCall(CALL, { agentId: MEMBER, mode: "blind" });
    await rest.transferCall(CALL, { queueId: CONV });
    await rest.transferCall(CALL, { number: "+84901234567" });
    await rest.holdCall(CALL, true);
    await rest.wrapUp(CALL, { dispositionCode: "resolved", notes: "ok" });
    await rest.setStatus("away");
    const posts = calls.filter((c) => c.method === "POST" && c.url.pathname !== "/agent/v1/sessions");
    for (const p of posts) expect(p.headers["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(posts.map((p) => p.headers["idempotency-key"])).size).toBe(posts.length);
    expect(posts.map((p) => p.body)).toEqual([
      {}, { targetAgentId: MEMBER, mode: "blind" }, { queueId: CONV }, { number: "+84901234567", mode: "warm" }, { on: true }, { dispositionCode: "resolved", notes: "ok" },
    ]);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url.pathname).toBe("/agent/v1/me/status");
    expect(put.body).toEqual({ status: "away" });
  });

  it("401 token_expired: ONE refresh for many parallel callers, each retried once with the same Idempotency-Key", async () => {
    let refreshes = 0;
    const { rest, session, calls } = wired((u, init) => {
      if (u.pathname === "/agent/v1/sessions") return { status: 201, body: S2.session(1) };
      if (u.pathname === "/agent/v1/sessions/refresh") { refreshes++; return { status: 200, body: S2.session(2) }; }
      return init.headers["authorization"] === `Bearer ${jwt(1)}` ? { status: 401, body: S2.errors.tokenExpired } : { status: 200, body: { ok: true } };
    });
    await session.signIn();
    await Promise.all([rest.typing(CONV), rest.typing(CONV), rest.typing(CONV), rest.me()]);
    expect(refreshes).toBe(1);
    const typing = calls.filter((c) => c.url.pathname.endsWith("/typing"));
    expect(typing).toHaveLength(6);
    const byKey = new Map<string, string[]>();
    for (const c of typing) byKey.set(c.headers["idempotency-key"]!, [...(byKey.get(c.headers["idempotency-key"]!) ?? []), c.headers["authorization"]!]);
    expect(byKey.size).toBe(3);
    for (const auths of byKey.values()) expect(auths).toEqual([`Bearer ${jwt(1)}`, `Bearer ${jwt(2)}`]);
  });

  it("a refused refresh signs in again with a NEW assertion from getAssertion", async () => {
    let n = 0;
    const getAssertion = vi.fn(async () => jwt(100 + ++n));
    const { rest, session } = wired((u, init) => {
      if (u.pathname === "/agent/v1/sessions") return { status: 201, body: S2.session(10 + n) };
      if (u.pathname === "/agent/v1/sessions/refresh") return { status: 401, body: S2.errors.refreshReused };
      return init.headers["authorization"] === `Bearer ${jwt(11)}` ? { status: 401, body: S2.errors.tokenExpired } : { status: 200, body: S2.me };
    }, getAssertion);
    await session.signIn();
    const me = await rest.me();
    expect(me.id).toBe(MEMBER);
    expect(getAssertion).toHaveBeenCalledTimes(2);
    expect(session.current?.accessToken).toBe(jwt(12));
  });

  it("401 session_revoked is final: no refresh, no retry", async () => {
    let refreshes = 0;
    const { rest, session, calls } = wired((u) => {
      if (u.pathname === "/agent/v1/sessions") return { status: 201, body: S2.session(1) };
      if (u.pathname.endsWith("/refresh")) { refreshes++; return { status: 200, body: S2.session(2) }; }
      return { status: 401, body: S2.errors.revoked };
    });
    await session.signIn();
    await expect(rest.me()).rejects.toMatchObject({ status: 401, code: "session_revoked" });
    expect(refreshes).toBe(0);
    expect(calls.filter((c) => c.url.pathname === "/agent/v1/me")).toHaveLength(1);
  });

  it("maps the {error:{code,message}} envelope to HainivaAgentError; 5xx and non-JSON bodies too", async () => {
    let next: { status: number; body?: unknown; headers?: Record<string, string> } = { status: 403, body: S2.errors.supervisorOnly };
    const { rest, session } = wired((u) => (u.pathname === "/agent/v1/sessions" ? { status: 201, body: S2.session(1) } : next));
    await session.signIn();
    await expect(rest.liveCalls()).rejects.toMatchObject({ name: "HainivaAgentError", status: 403, code: "supervisor_only", body: { message: "Only a supervisor can do this" } });
    next = { status: 404, body: S2.errors.notFound };
    await expect(rest.getCall(CALL)).rejects.toMatchObject({ status: 404, code: "not_found" });
    next = { status: 502, body: "<html>Bad gateway</html>", headers: { "content-type": "text/html" } };
    await expect(rest.me()).rejects.toMatchObject({ status: 502, code: "server_error" });
    next = { status: 429, body: { error: { code: "rate_limited", message: "Too many requests" } }, headers: { "retry-after": "7", "content-type": "application/json" } };
    await expect(rest.me()).rejects.toMatchObject({ status: 429, code: "rate_limited", body: { retryAfterSec: 7 } });
    next = { status: 200, body: "not json", headers: { "content-type": "text/plain" } };
    await expect(rest.me()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("lists are defensive: a non-array data is an empty list", async () => {
    let body: unknown = S2.rings;
    const { rest, session } = wired((u) => (u.pathname === "/agent/v1/sessions" ? { status: 201, body: S2.session(1) } : { status: 200, body }));
    await session.signIn();
    expect(await rest.pendingRings()).toHaveLength(1);
    body = S2.conversations;
    expect((await rest.listConversations({ scope: "mine" })).nextCursor).toBe("Y3Vyc29y");
    body = S2.dispositions;
    expect((await rest.dispositions())[0]!.code).toBe("resolved");
    body = { data: "oops" };
    expect(await rest.pendingRings()).toEqual([]);
    expect((await rest.listConversations()).data).toEqual([]);
  });

  it("refuses an id that is not a UUID before anything is sent (no path tricks)", async () => {
    const { rest, session, calls } = wired(() => ({ status: 201, body: S2.session(1) }));
    await session.signIn();
    const n = calls.length;
    await expect(rest.acceptCall("../../v1/members")).rejects.toMatchObject({ code: "invalid_id" });
    expect(calls.length).toBe(n);
  });

  it("times out, and honours an AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch(() => new Promise(() => {}));
      const rest = new AgentRestClient({ baseUrl: BASE, tenantId: T, fetch: (async (u: unknown, init: RequestInit) => {
        return new Promise((_res, rej) => { init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); void f.fn(u as string, init); });
      }) as unknown as typeof fetch, timeoutMs: 1000 }, { accessToken: async () => jwt(1), invalidate: () => {} });
      const p = rest.me();
      const assertion = expect(p).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
      const ctl = new AbortController();
      const q = rest.me({ signal: ctl.signal });
      const assertion2 = expect(q).rejects.toMatchObject({ code: "aborted" });
      await vi.advanceTimersByTimeAsync(1);
      ctl.abort();
      await assertion2;
    } finally { vi.useRealTimers(); }
  });

  it("never puts a token in an error, even when the server echoes it", async () => {
    const { rest, session } = wired((u) => (u.pathname === "/agent/v1/sessions" ? { status: 201, body: S2.session(1) } : { status: 400, body: { error: { code: "invalid_request", message: `bad token ${jwt(1)} and hnv_rt_${"r".repeat(20)}1` } } }));
    await session.signIn();
    const e = (await rest.me().then(() => null, (x: unknown) => x)) as HainivaAgentError;
    expect(JSON.stringify(e.body) + e.message).not.toContain(jwt(1));
    expect(JSON.stringify(e.body)).not.toContain("r".repeat(20));
  });
});

describe("configuration mistakes are refused", () => {
  const f = fakeFetch(() => ({ status: 200, body: {} })).fn;
  it("http://, credentials or a query in baseUrl; a bad tenant id", () => {
    expect(() => new AgentRestClient({ baseUrl: "http://api.example.test", tenantId: T, fetch: f })).toThrow(/insecure_url/);
    expect(() => new AgentRestClient({ baseUrl: "https://u:p@api.example.test", tenantId: T, fetch: f })).toThrow(/credentials_in_url/);
    expect(() => new AgentRestClient({ baseUrl: "https://api.example.test/?token=x", tenantId: T, fetch: f })).toThrow(/credentials_in_url/);
    expect(() => new AgentRestClient({ baseUrl: "https://api.example.test/?a=b", tenantId: T, fetch: f })).toThrow(/invalid_url/);
    expect(() => new AgentRestClient({ baseUrl: BASE, tenantId: "bad tenant/../", fetch: f })).toThrow(/invalid_tenant_id/);
    expect(new AgentRestClient({ baseUrl: "http://localhost:3001/", tenantId: T, fetch: f, allowInsecureLocalhost: true }).wsUrl).toBe("ws://localhost:3001/agent/v1/ws");
    expect(new AgentRestClient({ baseUrl: `${BASE}/`, tenantId: T, fetch: f }).wsUrl).toBe("wss://api.example.test/agent/v1/ws");
  });
  it("errorFromResponse without an envelope falls back on the status", () => {
    expect(errorFromResponse(409, null).code).toBe("conflict");
    expect(errorFromResponse(400, { error: "plain string" }).body).toEqual({ message: "plain string" });
  });
  it("newIdempotencyKey is a v4 UUID", () => {
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
