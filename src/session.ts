import { TypedEmitter } from "./emitter.js";
import { HainivaAgentError } from "./errors.js";
import { safeLogger, type Logger } from "./log.js";
import { Redactor } from "./redact.js";
import { singleFlight } from "./singleFlight.js";

/**
 * Where the session is kept between launches. Same shape as @hainiva/app-sdk's.
 * The default is in memory (nothing persisted). On the web, `localStorageStore`
 * (`@hainiva/agent-sdk/web`) is opt-in; in React Native use
 * `secureStoreSessionStore` (`@hainiva/agent-sdk/react-native`) — the refresh
 * token then lives only in the Keychain / Android Keystore.
 */
export interface SessionStore {
  get(): Promise<string | null> | string | null;
  set(value: string): Promise<void> | void;
  remove(): Promise<void> | void;
}

/** Keeps the session for the life of the page / JS context only. The default. */
export function memoryStore(): SessionStore {
  let v: string | null = null;
  return { get: () => v, set: (x) => { v = x; }, remove: () => { v = null; } };
}

/** A staff session. Fields beyond these are kept as the server sent them. */
export interface AgentSession {
  accessToken: string;
  /** ISO time. */
  accessExpiresAt: string;
  refreshToken: string;
  /** ISO time. */
  refreshExpiresAt: string;
  [field: string]: unknown;
}

/**
 * Ask YOUR backend for a fresh staff assertion (a short-lived JWT it signs with
 * the agent app's private key). Called every time a new session is needed —
 * the SDK never caches or stores an assertion, and you must not either: each
 * one carries a single-use `jti` and expires in minutes.
 */
export type GetAssertion = () => Promise<string>;

/**
 * How sessions are created and refreshed — bound by the REST client.
 * TODO(S3b): implemented against `/agent/v1/sessions` once the S2 contract is final.
 */
export interface SessionTransport<S extends AgentSession = AgentSession> {
  /** Exchange an assertion for a session (POST /agent/v1/sessions). */
  exchange(assertion: string): Promise<S>;
  /** Rotate: a new access token and (rotating) refresh token. */
  refresh(refreshToken: string): Promise<Pick<S, "accessToken" | "accessExpiresAt"> & Partial<S>>;
  /** End the session on the server (best effort). */
  revoke?(session: S): Promise<void>;
}

export interface SessionManagerOptions<S extends AgentSession> {
  getAssertion: GetAssertion;
  transport: SessionTransport<S>;
  /** Default: memoryStore(). */
  store?: SessionStore;
  /** Refresh this long before the access token expires. Default 60 s. */
  refreshSkewMs?: number;
  now?: () => number;
  redactor?: Redactor;
  log?: Logger;
}

export interface SessionEvents<S extends AgentSession> {
  /** A new access token (after sign-in or refresh): e.g. send it on the socket. */
  token: string;
  session: S | null;
}

const isSession = (v: unknown): v is AgentSession => {
  const s = v as Record<string, unknown> | null;
  return !!s && typeof s === "object" && typeof s["accessToken"] === "string" && typeof s["refreshToken"] === "string"
    && typeof s["accessExpiresAt"] === "string" && typeof s["refreshExpiresAt"] === "string";
};

/**
 * The staff session: sign in with a fresh assertion, keep it in the store,
 * refresh before expiry (single flight — one refresh however many callers),
 * sign in again with a NEW assertion when the refresh is refused.
 */
export class SessionManager<S extends AgentSession = AgentSession> {
  readonly events = new TypedEmitter<SessionEvents<S>>();
  private session: S | null = null;
  private readonly store: SessionStore;
  private readonly skew: number;
  private readonly now: () => number;
  readonly redactor: Redactor;
  private readonly log: Logger;
  private readonly refreshOnce: () => Promise<S>;
  private forceNext = false;

  constructor(private readonly o: SessionManagerOptions<S>) {
    this.store = o.store ?? memoryStore();
    this.skew = o.refreshSkewMs ?? 60_000;
    this.now = o.now ?? Date.now;
    this.redactor = o.redactor ?? new Redactor();
    this.log = safeLogger(o.log, this.redactor);
    this.refreshOnce = singleFlight(() => this.doRefresh());
  }

  get current(): S | null { return this.session; }

  /** Restore the stored session if it can still be refreshed, else sign in afresh. */
  async signIn(): Promise<S> {
    const saved = await Promise.resolve().then(() => this.store.get()).catch((e) => { this.log("store_read_failed", e); return null; });
    if (saved) {
      try {
        const s = JSON.parse(saved) as unknown;
        if (isSession(s) && Date.parse(s.refreshExpiresAt) > this.now() + this.skew) {
          this.adopt(s as S);
          return await this.fresh();
        }
      } catch { /* corrupt or refused: sign in afresh */ }
      await Promise.resolve().then(() => this.store.remove()).catch(() => undefined);
    }
    return this.freshSignIn();
  }

  /** A valid access token, refreshing first when it is about to expire. */
  async accessToken(): Promise<string> {
    return (await this.fresh()).accessToken;
  }

  /**
   * The server refused the access token (401 / socket 4001): the next
   * accessToken() refreshes. Pass the token that was refused: a refusal of an
   * OLDER token (a request that was in flight while another caller already
   * refreshed) is ignored, so ten parallel 401s cause one refresh, not ten.
   */
  invalidate(refused?: string): void {
    if (refused && this.session && this.session.accessToken !== refused) return;
    this.forceNext = true;
  }

  /** Forget the session here only (the server already ended it): no revoke call. */
  async clear(): Promise<void> {
    this.adopt(null);
    await Promise.resolve().then(() => this.store.remove()).catch(() => undefined);
  }

  /** End the session here and (best effort) on the server. */
  async signOut(): Promise<void> {
    const s = this.session;
    this.adopt(null);
    await Promise.resolve().then(() => this.store.remove()).catch(() => undefined);
    if (s && this.o.transport.revoke) await this.o.transport.revoke(s).catch((e) => this.log("revoke_failed", e));
    this.redactor.clear();
  }

  private async fresh(): Promise<S> {
    if (!this.session) return this.freshSignIn();
    const left = Date.parse(this.session.accessExpiresAt) - this.now();
    if (!this.forceNext && left > this.skew) return this.session;
    return this.refreshOnce();
  }

  private async doRefresh(): Promise<S> {
    const s = this.session;
    if (!s) return this.freshSignIn();
    this.forceNext = false;
    try {
      const r = await this.o.transport.refresh(s.refreshToken);
      if (!r || typeof r.accessToken !== "string" || !r.accessToken) throw new HainivaAgentError(0, "refresh_failed", {}, this.redactor);
      const next = { ...s, ...r } as S;
      await this.keep(next);
      return next;
    } catch (e) {
      // Refused (expired, revoked, reused): a new session from a NEW assertion.
      if (e instanceof HainivaAgentError && (e.status === 401 || e.status === 403)) {
        this.log("refresh_refused", { status: e.status });
        await Promise.resolve().then(() => this.store.remove()).catch(() => undefined);
        this.adopt(null);
        return this.freshSignIn();
      }
      this.forceNext = true;
      throw HainivaAgentError.from(e, "refresh_failed", this.redactor);
    }
  }

  private readonly freshSignIn = singleFlight(async (): Promise<S> => {
    // Always a new assertion: never cached, never stored, never reused.
    let assertion: string;
    try { assertion = await this.o.getAssertion(); }
    catch (e) { throw HainivaAgentError.from(e, "assertion_failed", this.redactor); }
    if (typeof assertion !== "string" || assertion.split(".").length !== 3) {
      throw new HainivaAgentError(0, "invalid_assertion", { hint: "getAssertion must resolve to a signed JWT from your backend" });
    }
    this.redactor.add(assertion);
    try {
      const s = await this.o.transport.exchange(assertion);
      if (!isSession(s)) throw new HainivaAgentError(0, "invalid_session", {}, this.redactor);
      await this.keep(s);
      return s;
    } catch (e) {
      throw HainivaAgentError.from(e, "sign_in_failed", this.redactor);
    } finally {
      this.redactor.remove(assertion);
    }
  });

  private async keep(s: S): Promise<void> {
    this.adopt(s);
    await Promise.resolve().then(() => this.store.set(JSON.stringify(s))).catch((e) => this.log("store_write_failed", e));
  }

  private adopt(s: S | null): void {
    const prev = this.session;
    this.session = s;
    // Old tokens stay redacted: they may still appear in an in-flight error.
    if (s) this.redactor.add(s.accessToken, s.refreshToken);
    this.events.emit("session", s);
    if (s && s.accessToken !== prev?.accessToken) this.events.emit("token", s.accessToken);
  }
}
