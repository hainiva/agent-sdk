import { describe, expect, it, vi } from "vitest";
import { TypedEmitter } from "./emitter.js";
import { HainivaAgentError } from "./errors.js";
import { safeLogger } from "./log.js";
import { Redactor, redactString, redactValue } from "./redact.js";
import { assertSafeUrl } from "./url.js";
import { mountDesk } from "./embed.js";
import { localStorageStore, memoryStore } from "./web.js";
import { secureStoreSessionStore } from "./react-native.js";

const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJzdGFmZi0xIn0.MEUCIQDsig";

describe("redaction", () => {
  it("removes JWTs, Bearer values, token query params and key prefixes", () => {
    // Built at runtime so the source holds nothing shaped like a real key
    // (secret scanning would flag it in the public repo).
    const apiKey = ["aicc", "live", "ABCDEFGH12"].join("_");
    const s = redactString(`auth ${JWT} | Authorization: Bearer abcdefgh12345 | wss://x/rtc?access_token=SECRET&x=1 | ${apiKey} | agr_0123456789`);
    expect(s).not.toContain(JWT);
    expect(s).not.toContain("abcdefgh12345");
    expect(s).not.toContain("SECRET");
    expect(s).not.toContain("ABCDEFGH12");
    expect(s).not.toContain("0123456789");
    expect(s).toContain("x=1");
  });

  it("blanks sensitive keys deep inside objects and flattens Errors", () => {
    const v = redactValue({ a: { refreshToken: "r", accessToken: "a", password: "p", ok: "fine" }, list: [{ assertion: JWT }], e: new Error(`bad ${JWT}`) }) as Record<string, any>;
    expect(v.a).toEqual({ refreshToken: "[redacted]", accessToken: "[redacted]", password: "[redacted]", ok: "fine" });
    expect(v.list[0].assertion).toBe("[redacted]");
    expect(v.e.message).not.toContain(JWT);
  });

  it("the Redactor also removes opaque secrets it was told about", () => {
    const r = new Redactor();
    r.add("opaque-token-123456");
    expect(r.string("failed with opaque-token-123456")).toBe("failed with [redacted]");
    r.remove("opaque-token-123456");
    expect(r.string("opaque-token-123456")).toBe("opaque-token-123456");
  });

  it("HainivaAgentError redacts its body and code, and from() wraps foreign errors", () => {
    const e = new HainivaAgentError(401, "bad", { token: JWT, detail: `got ${JWT}` });
    expect(e.message).toBe("401 bad");
    expect(JSON.stringify(e.body)).not.toContain(JWT);
    const w = HainivaAgentError.from(new Error(`connect wss://lk/rtc?access_token=${JWT}`), "media");
    expect(w.status).toBe(0);
    expect(JSON.stringify(w.body)).not.toContain(JWT);
    expect(HainivaAgentError.from(e)).toBe(e);
  });

  it("safeLogger redacts what reaches the partner's logger and survives a broken one", () => {
    const log = vi.fn();
    safeLogger(log)("socket_closed", { token: JWT, code: 1006, url: `wss://h/ws?token=${JWT}` });
    expect(JSON.stringify(log.mock.calls)).not.toContain(JWT);
    expect(() => safeLogger(() => { throw new Error("x"); })("e")).not.toThrow();
    expect(() => safeLogger(undefined)("e")).not.toThrow();
  });
});

describe("assertSafeUrl", () => {
  it("requires TLS (https / wss)", () => {
    expect(assertSafeUrl("https://api.hainiva.com", { kind: "http" }).host).toBe("api.hainiva.com");
    expect(assertSafeUrl("wss://api.hainiva.com/agent/v1/ws", { kind: "ws" }).protocol).toBe("wss:");
    expect(() => assertSafeUrl("http://api.hainiva.com", { kind: "http" })).toThrow(/insecure_url/);
    expect(() => assertSafeUrl("ws://api.hainiva.com", { kind: "ws" })).toThrow(/insecure_url/);
    expect(() => assertSafeUrl("https://api.hainiva.com", { kind: "ws" })).toThrow(/insecure_url/);
    expect(() => assertSafeUrl("not a url", { kind: "http" })).toThrow(/invalid_url/);
  });

  it("allows plain localhost only when asked", () => {
    expect(() => assertSafeUrl("ws://localhost:3001/ws", { kind: "ws" })).toThrow();
    expect(assertSafeUrl("ws://localhost:3001/ws", { kind: "ws", allowInsecureLocalhost: true }).port).toBe("3001");
    expect(() => assertSafeUrl("ws://evil.example/ws", { kind: "ws", allowInsecureLocalhost: true })).toThrow();
  });

  it("refuses credentials in the URL", () => {
    for (const u of ["wss://x/ws?token=abc", "wss://x/ws?access_token=abc", "wss://user:pw@x/ws", `wss://x/ws/${JWT}`, "wss://x/ws?Assertion=1", "https://x/?api_key=1"]) {
      expect(() => assertSafeUrl(u, { kind: u.startsWith("https") ? "http" : "ws" }), u).toThrow(/credentials_in_url/);
    }
    // The error never repeats the query value.
    try { assertSafeUrl("wss://x/ws?token=SUPERSECRET", { kind: "ws" }); } catch (e) { expect(JSON.stringify(e) + String(e)).not.toContain("SUPERSECRET"); }
  });
});

describe("TypedEmitter", () => {
  it("on / once / off / emit, void payloads, and isolation of a throwing listener", () => {
    const errors: unknown[] = [];
    const e = new TypedEmitter<{ n: number; ready: undefined }>((err) => errors.push(err));
    const got: number[] = [];
    const off = e.on("n", (x) => got.push(x));
    e.once("n", (x) => got.push(x * 10));
    e.on("n", () => { throw new Error("boom"); });
    let ready = 0;
    e.on("ready", () => { ready++; });
    e.emit("n", 1);
    e.emit("n", 2);
    off();
    e.emit("n", 3);
    e.emit("ready", undefined);
    expect(got).toEqual([1, 10, 2]);
    expect(ready).toBe(1);
    expect(errors.length).toBe(3);
    expect(e.listenerCount("n")).toBe(1);
    e.removeAll();
    expect(e.listenerCount("n")).toBe(0);
  });
});

describe("stores", () => {
  it("memoryStore keeps a value for the session only", async () => {
    const s = memoryStore();
    expect(await s.get()).toBeNull();
    await s.set("x");
    expect(await s.get()).toBe("x");
    await s.remove();
    expect(await s.get()).toBeNull();
  });

  it("localStorageStore is opt-in and uses the given storage and key", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
    const s = localStorageStore({ storage, key: "k" });
    s.set("v");
    expect(data.get("k")).toBe("v");
    expect(s.get()).toBe("v");
    s.remove();
    expect(data.has("k")).toBe(false);
    expect(() => localStorageStore()).toThrow(/not available/); // Node: no localStorage
  });

  it("secureStoreSessionStore uses SecureStore only, readable while locked, this device only", async () => {
    const calls: unknown[][] = [];
    const secure = {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 5,
      getItemAsync: async (...a: unknown[]) => { calls.push(["get", ...a]); return "s"; },
      setItemAsync: async (...a: unknown[]) => { calls.push(["set", ...a]); },
      deleteItemAsync: async (...a: unknown[]) => { calls.push(["del", ...a]); },
    };
    const s = secureStoreSessionStore(secure);
    expect(await s.get()).toBe("s");
    await s.set("v");
    await s.remove();
    expect(calls).toEqual([
      ["get", "hainiva.agent.session", { keychainAccessible: 5 }],
      ["set", "hainiva.agent.session", "v", { keychainAccessible: 5 }],
      ["del", "hainiva.agent.session", { keychainAccessible: 5 }],
    ]);
    expect(() => secureStoreSessionStore(secure, { key: "bad key/" })).toThrow();
  });

  it("a failing SecureStore rejects (no silent fallback to a plain store)", async () => {
    const secure = { getItemAsync: async () => { throw new Error("locked"); }, setItemAsync: async () => { throw new Error("locked"); }, deleteItemAsync: async () => undefined };
    const s = secureStoreSessionStore(secure);
    await expect(Promise.resolve(s.set("v"))).rejects.toThrow("locked");
  });
});

describe("embed", () => {
  it("is not available yet", () => {
    expect(() => mountDesk()).toThrow("@hainiva/agent-sdk/embed is not yet available");
  });
});
