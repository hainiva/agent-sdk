/**
 * The REST client for the Agent API (`/agent/v1/*`).
 *
 *  - `baseUrl` is checked with assertSafeUrl (HTTPS only, no credential in it);
 *  - the access token goes in the Authorization header only — never in a URL;
 *  - a 401 `token_expired` (or `token_invalid`) refreshes ONCE (single flight
 *    across every caller: SessionManager) and retries the request once; a
 *    refused refresh signs in again with a NEW assertion from `getAssertion`;
 *    a 401 `session_revoked` is final (the facade emits `revoked`);
 *  - every POST carries an `Idempotency-Key` (the retry after a refresh reuses
 *    it, so the server never does the action twice);
 *  - each request has a timeout (default 15 s) and honours an AbortSignal;
 *  - any non-2xx becomes a HainivaAgentError {status, code, body} from the
 *    server's `{error:{code,message}}` envelope, redacted; non-JSON or
 *    non-object bodies are handled defensively.
 */
import type {
  AgentAcceptDto, AgentCallDto, AgentConversationDto, AgentDispositionDto, AgentMeDto, AgentMediaTokenDto,
  AgentMessageDto, AgentPage, AgentPresenceStatus, AgentPushSubscriptionDto, AgentPushSubscriptionInput, AgentRingDto,
  AgentSessionDto, SupervisorAgentDto, SupervisorLiveCallDto, SupervisorSuperviseDto,
} from "./contract.js";
import { HainivaAgentError } from "./errors.js";
import { safeLogger, type Logger } from "./log.js";
import { Redactor } from "./redact.js";
import type { AgentSession, SessionTransport } from "./session.js";
import { assertSafeUrl } from "./url.js";

export interface AgentRestOptions {
  /** e.g. https://api.hainiva.com (HTTPS only). */
  baseUrl: string;
  /** Your HAINIVA organisation id: sign-in and refresh name it. */
  tenantId: string;
  fetch?: typeof fetch;
  /** Per request, default 15 000 ms. */
  timeoutMs?: number;
  /** Local development only: http://localhost. */
  allowInsecureLocalhost?: boolean;
  /** Device shown to the organisation's admins in the session list. */
  device?: { label?: string; platform?: "ios" | "android" | "web" | "other" };
  redactor?: Redactor;
  log?: Logger;
}

/** Where the client gets its access token, and how it reports a refused one. */
export interface TokenSource {
  accessToken(): Promise<string>;
  /** The server refused this token: refresh before the next request. */
  invalidate(refused?: string): void;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /** Overrides the client's timeout for this request. */
  timeoutMs?: number;
}

/** LiveKit room credentials for a call. */
export type MediaCredentials = AgentMediaTokenDto;

export type AgentStatus = AgentPresenceStatus;

/** Where a call is transferred. */
export type CallTransferTarget =
  | { agentId: string; mode?: "warm" | "blind" }
  | { queueId: string }
  | { number: string; mode?: "warm" | "blind" };

export interface ConversationListQuery { scope?: "all" | "mine"; status?: "open" | "closed" | "all"; cursor?: string; limit?: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = /^[A-Za-z0-9_-]{1,64}$/;

/** A random UUID v4: crypto.randomUUID where it exists (browsers, Node), else getRandomValues, else Math.random (Idempotency-Key only, not a secret). */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** An id that goes into a path: a UUID, or the request is refused before it leaves (no path tricks). */
function id(v: string, what: string): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new HainivaAgentError(0, "invalid_id", { field: what });
  return v.toLowerCase();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Pure: the error a non-2xx answer becomes. Exported for tests. */
export function errorFromResponse(status: number, data: unknown, redactor?: Redactor, retryAfter?: string | null): HainivaAgentError {
  const e = isObject(data) ? data["error"] : undefined;
  let code = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 409 ? "conflict" : status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "invalid_request";
  let message: string | undefined;
  if (isObject(e)) {
    if (typeof e["code"] === "string" && e["code"]) code = e["code"].slice(0, 80);
    if (typeof e["message"] === "string") message = e["message"].slice(0, 500);
  } else if (typeof e === "string") {
    message = e.slice(0, 500);
  }
  const body: Record<string, unknown> = {};
  if (message) body["message"] = message;
  if (retryAfter && /^\d{1,6}$/.test(retryAfter)) body["retryAfterSec"] = Number(retryAfter);
  return new HainivaAgentError(status, code, body, redactor);
}

/**
 * The Agent API over fetch. `tokens` is normally the SessionManager; the
 * client's own `sessions` transport is what that SessionManager signs in with.
 */
export class AgentRestClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly redactor: Redactor;
  private readonly log: Logger;
  private tokens: TokenSource | null;

  constructor(private readonly o: AgentRestOptions, tokens?: TokenSource) {
    const u = assertSafeUrl(o.baseUrl, { kind: "http", ...(o.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}) });
    if (u.search || u.hash) throw new HainivaAgentError(0, "invalid_url", { hint: "baseUrl takes no query or fragment" });
    if (typeof o.tenantId !== "string" || !TENANT.test(o.tenantId)) throw new HainivaAgentError(0, "invalid_tenant_id");
    this.baseUrl = u.origin + u.pathname.replace(/\/+$/, "");
    const f = o.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) throw new HainivaAgentError(0, "no_fetch", { hint: "pass options.fetch" });
    this.fetchFn = f.bind(globalThis);
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.redactor = o.redactor ?? new Redactor();
    this.log = safeLogger(o.log, this.redactor);
    this.tokens = tokens ?? null;
  }

  /** Attach the token source after construction (the SessionManager needs `sessions` first). */
  useTokens(tokens: TokenSource): void { this.tokens = tokens; }

  /** The wss:// URL of the event stream, derived from baseUrl (never from a server answer). */
  get wsUrl(): string {
    return `${this.baseUrl.replace(/^http/, "ws")}/agent/v1/ws`;
  }

  // ── Sessions (the SessionManager's transport) ───────────────────────────────

  readonly sessions: SessionTransport<AgentSession & AgentSessionDto> = {
    exchange: (assertion) => this.raw<AgentSessionDto>("POST", "/agent/v1/sessions", {
      body: { tenantId: this.o.tenantId, assertion, ...(this.o.device ? { device: this.o.device } : {}) },
    }, null).then((s) => s as AgentSession & AgentSessionDto),
    refresh: (refreshToken) => this.raw<AgentSessionDto>("POST", "/agent/v1/sessions/refresh", {
      body: { tenantId: this.o.tenantId, refreshToken },
    }, null).then((s) => s as AgentSession & AgentSessionDto),
    revoke: async (session) => {
      await this.raw<void>("DELETE", "/agent/v1/sessions/current", {}, session.accessToken);
    },
  };

  // ── The generic request ─────────────────────────────────────────────────────

  /** An authenticated request: refresh-and-retry once on an expired token. */
  async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: RequestOptions = {}): Promise<T> {
    if (!this.tokens) throw new HainivaAgentError(0, "not_signed_in");
    const idem = method === "POST" ? newIdempotencyKey() : undefined;
    const token = await this.tokens.accessToken();
    try {
      return await this.raw<T>(method, path, opts, token, idem);
    } catch (e) {
      if (!(e instanceof HainivaAgentError) || e.status !== 401 || (e.code !== "token_expired" && e.code !== "token_invalid")) throw e;
      this.log("access_token_refused", { code: e.code });
      this.tokens.invalidate(token);
      const next = await this.tokens.accessToken();
      return this.raw<T>(method, path, opts, next, idem);
    }
  }

  private async raw<T>(method: string, path: string, opts: RequestOptions, token: string | null, idem?: string): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (opts.query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== "") q.set(k, String(v));
      const s = q.toString();
      if (s) url += `?${s}`;
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) { this.redactor.add(token); headers["authorization"] = `Bearer ${token}`; }
    if (idem) headers["idempotency-key"] = idem;
    let body: string | undefined;
    if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }

    const ctl = new AbortController();
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeout);
    const onAbort = () => ctl.abort();
    if (opts.signal) {
      if (opts.signal.aborted) { clearTimeout(timer); throw new HainivaAgentError(0, "aborted"); }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: ctl.signal });
    } catch (e) {
      if (timedOut) throw new HainivaAgentError(0, "timeout", { timeoutMs: timeout });
      if (opts.signal?.aborted) throw new HainivaAgentError(0, "aborted");
      throw HainivaAgentError.from(e, "network_error", this.redactor);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (res.status === 204) return undefined as T;
    let data: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!res.ok) throw errorFromResponse(res.status, data, this.redactor, res.headers?.get?.("retry-after") ?? null);
    if (data === null || typeof data !== "object") throw new HainivaAgentError(res.status, "invalid_response", {}, this.redactor);
    return data as T;
  }

  // ── Me ──────────────────────────────────────────────────────────────────────

  async me(o?: RequestOptions): Promise<AgentMeDto> { return this.request("GET", "/agent/v1/me", o); }

  async setStatus(status: AgentStatus, o?: RequestOptions): Promise<{ status: AgentStatus }> {
    return this.request("PUT", "/agent/v1/me/status", { ...o, body: { status } });
  }

  /** Rings for this member now (after a cold start, a missed push or a resync). */
  async pendingRings(o?: RequestOptions): Promise<AgentRingDto[]> {
    const r = await this.request<{ data?: unknown }>("GET", "/agent/v1/rings/pending", o);
    return Array.isArray(r.data) ? (r.data as AgentRingDto[]) : [];
  }

  // ── Calls ───────────────────────────────────────────────────────────────────

  async getCall(callId: string, o?: RequestOptions): Promise<AgentCallDto> { return this.request("GET", `/agent/v1/calls/${id(callId, "callId")}`, o); }
  async acceptCall(callId: string, o?: RequestOptions): Promise<AgentAcceptDto> { return this.request("POST", `/agent/v1/calls/${id(callId, "callId")}/accept`, { ...o, body: {} }); }
  async declineCall(callId: string, o?: RequestOptions): Promise<{ callId: string; declined: true }> { return this.request("POST", `/agent/v1/calls/${id(callId, "callId")}/decline`, { ...o, body: {} }); }
  async endCall(callId: string, o?: RequestOptions): Promise<{ callId: string; ended: true }> { return this.request("POST", `/agent/v1/calls/${id(callId, "callId")}/end`, { ...o, body: {} }); }
  async holdCall(callId: string, on: boolean, o?: RequestOptions): Promise<{ callId: string; onHold: boolean }> {
    return this.request("POST", `/agent/v1/calls/${id(callId, "callId")}/hold`, { ...o, body: { on } });
  }
  async transferCall(callId: string, target: CallTransferTarget, o?: RequestOptions): Promise<{ callId: string; transferred: true }> {
    let body: Record<string, unknown>;
    if ("agentId" in target) body = { targetAgentId: id(target.agentId, "agentId"), mode: target.mode ?? "warm" };
    else if ("queueId" in target) body = { queueId: id(target.queueId, "queueId") };
    else body = { number: target.number, mode: target.mode ?? "warm" };
    return this.request("POST", `/agent/v1/calls/${id(callId, "callId")}/transfer`, { ...o, body });
  }
  /** Re-mint the LiveKit token while still a participant (reconnect, token near expiry). */
  async mediaToken(callId: string, o?: RequestOptions): Promise<MediaCredentials> { return this.request("POST", `/agent/v1/calls/${id(callId, "callId")}/media-token`, { ...o, body: {} }); }

  // ── Wrap-up ─────────────────────────────────────────────────────────────────

  async dispositions(channel?: string, o?: RequestOptions): Promise<AgentDispositionDto[]> {
    const r = await this.request<{ data?: unknown }>("GET", "/agent/v1/dispositions", { ...o, ...(channel ? { query: { channel } } : {}) });
    return Array.isArray(r.data) ? (r.data as AgentDispositionDto[]) : [];
  }
  async wrapUp(callId: string, w: { dispositionCode?: string; notes?: string } = {}, o?: RequestOptions): Promise<{ callId: string; wrappedUp: true }> {
    return this.request("POST", `/agent/v1/calls/${id(callId, "callId")}/wrapup`, { ...o, body: w });
  }

  // ── Conversations and messages ──────────────────────────────────────────────

  async listConversations(q: ConversationListQuery = {}, o?: RequestOptions): Promise<AgentPage<AgentConversationDto>> {
    return this.request("GET", "/agent/v1/conversations", { ...o, query: { scope: q.scope, status: q.status, cursor: q.cursor, limit: q.limit } }).then(page<AgentConversationDto>);
  }
  async getConversation(conversationId: string, o?: RequestOptions): Promise<AgentConversationDto> {
    return this.request("GET", `/agent/v1/conversations/${id(conversationId, "conversationId")}`, o);
  }
  /** Claim it (no agentId), or — a supervisor — assign it to a colleague. */
  async assignConversation(conversationId: string, agentId?: string, o?: RequestOptions): Promise<unknown> {
    return this.request("POST", `/agent/v1/conversations/${id(conversationId, "conversationId")}/assign`, { ...o, body: agentId ? { agentId: id(agentId, "agentId") } : {} });
  }
  async releaseConversation(conversationId: string, note?: string, o?: RequestOptions): Promise<{ conversationId: string; released: true }> {
    return this.request("POST", `/agent/v1/conversations/${id(conversationId, "conversationId")}/release`, { ...o, body: note ? { note } : {} });
  }
  async transferConversation(conversationId: string, to: { agentId: string } | { queueId: string; note?: string }, o?: RequestOptions): Promise<unknown> {
    const body = "agentId" in to ? { agentId: id(to.agentId, "agentId") } : { queueId: id(to.queueId, "queueId"), ...(to.note ? { note: to.note } : {}) };
    return this.request("POST", `/agent/v1/conversations/${id(conversationId, "conversationId")}/transfer`, { ...o, body });
  }
  async closeConversation(conversationId: string, o?: RequestOptions): Promise<{ conversationId: string; closed: true }> {
    return this.request("POST", `/agent/v1/conversations/${id(conversationId, "conversationId")}/close`, { ...o, body: {} });
  }
  async listMessages(conversationId: string, q: { after?: string; limit?: number } = {}, o?: RequestOptions): Promise<AgentPage<AgentMessageDto>> {
    return this.request("GET", `/agent/v1/conversations/${id(conversationId, "conversationId")}/messages`, { ...o, query: { after: q.after, limit: q.limit } }).then(page<AgentMessageDto>);
  }
  async sendMessage(conversationId: string, text: string, o?: RequestOptions): Promise<Pick<AgentMessageDto, "id" | "conversationId" | "interactionId" | "createdAt">> {
    return this.request("POST", `/agent/v1/conversations/${id(conversationId, "conversationId")}/messages`, { ...o, body: { text } });
  }
  async typing(conversationId: string, o?: RequestOptions): Promise<{ ok: true }> {
    return this.request("POST", `/agent/v1/conversations/${id(conversationId, "conversationId")}/typing`, { ...o, body: {} });
  }

  // ── Supervisor ──────────────────────────────────────────────────────────────

  async liveCalls(o?: RequestOptions): Promise<SupervisorLiveCallDto[]> {
    const r = await this.request<{ data?: unknown }>("GET", "/agent/v1/supervisor/live-calls", o);
    return Array.isArray(r.data) ? (r.data as SupervisorLiveCallDto[]) : [];
  }
  async teamAgents(o?: RequestOptions): Promise<SupervisorAgentDto[]> {
    const r = await this.request<{ data?: unknown }>("GET", "/agent/v1/supervisor/agents", o);
    return Array.isArray(r.data) ? (r.data as SupervisorAgentDto[]) : [];
  }
  async supervise(callId: string, mode: "monitor" | "whisper" | "barge" = "monitor", o?: RequestOptions): Promise<SupervisorSuperviseDto> {
    return this.request("POST", `/agent/v1/supervisor/calls/${id(callId, "callId")}/supervise`, { ...o, body: { mode } });
  }
  async setSuperviseMode(callId: string, mode: "monitor" | "whisper" | "barge", supervisorTrackSid?: string, o?: RequestOptions): Promise<{ callId: string; mode: string }> {
    return this.request("PUT", `/agent/v1/supervisor/calls/${id(callId, "callId")}/supervise-mode`, { ...o, body: { mode, ...(supervisorTrackSid ? { supervisorTrackSid } : {}) } });
  }

  // ── Push (your app's own FCM / APNs credentials, uploaded by your admin) ─────

  async registerPush(sub: AgentPushSubscriptionInput, o?: RequestOptions): Promise<AgentPushSubscriptionDto> {
    return this.request("POST", "/agent/v1/push/subscriptions", { ...o, body: sub });
  }
  async unregisterPush(token: string, o?: RequestOptions): Promise<void> {
    await this.request<unknown>("DELETE", "/agent/v1/push/subscriptions", { ...o, body: { token } });
  }
}

function page<T>(r: unknown): AgentPage<T> {
  const x = isObject(r) ? r : {};
  return { data: Array.isArray(x["data"]) ? (x["data"] as T[]) : [], nextCursor: typeof x["nextCursor"] === "string" ? x["nextCursor"] : null };
}
