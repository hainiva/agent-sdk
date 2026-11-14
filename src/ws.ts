import { TypedEmitter } from "./emitter.js";
import { HainivaAgentError } from "./errors.js";
import { safeLogger, type Logger } from "./log.js";
import { Redactor } from "./redact.js";
import { assertSafeUrl } from "./url.js";

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** Exponential backoff with full jitter: between half and all of min(max, initial·2^attempt). */
export function backoffDelay(attempt: number, initial = 1000, max = 30000, rnd: () => number = Math.random): number {
  const cap = Math.min(max, initial * 2 ** Math.max(0, attempt));
  return Math.round(cap / 2 + rnd() * (cap / 2));
}

/** The part of the WebSocket API this client uses (browser, React Native, `ws` in Node). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

type AnyFrame = Record<string, unknown>;

export interface SocketOptions<In = AnyFrame, Out = AnyFrame> {
  /** wss:// URL, or a function returning it. Never carries a credential (checked). */
  url: string | (() => string | Promise<string>);
  /** A valid access token (e.g. `session.accessToken()`); sent in the first frame. */
  getToken: () => Promise<string>;
  /** The server refused the token (close code `tokenExpired`): e.g. `session.invalidate()`. */
  onTokenRejected?: () => void;
  WebSocket?: WebSocketCtor;
  /** First frame after open. Default `{ type: "auth", token }`. */
  authFrame?: (token: string) => Out;
  /** Whether a frame is the server's "authenticated" answer. Default `type === "ready"`. */
  isReady?: (frame: In) => boolean;
  /** Give up on an open socket that is not ready after this long. Default 10 s. */
  authTimeoutMs?: number;
  /** Keep-alive. `false` turns it off. */
  heartbeat?: false | {
    /** Send `frame()` this often. Default 20 s. */
    intervalMs?: number;
    /** Reconnect when nothing at all was received for this long. Default 45 s. */
    timeoutMs?: number;
    /** Default `{ type: "ping" }`. */
    frame?: () => Out;
  };
  /** Resume hook: the frame to send after `ready` when frames were seen before. */
  resume?: (lastSeq: number) => Out | null;
  /** A frame's sequence number, if it has one. Default: numeric `seq`. */
  seqOf?: (frame: In) => number | undefined;
  /** Frame to hand the server a refreshed access token on an open socket. */
  tokenFrame?: (token: string) => Out;
  encode?: (frame: Out) => string;
  decode?: (raw: string) => In;
  backoff?: { initialMs?: number; maxMs?: number; random?: () => number };
  /**
   * Server close codes. Defaults: tokenExpired 4001 (refresh and reconnect),
   * revoked 4003 (stop). `fatal`: codes reconnecting cannot fix (stop, emit
   * `error` with code `socket_closed_<code>`). Default none.
   */
  closeCodes?: { tokenExpired?: number; revoked?: number; fatal?: number[] };
  /** Allow ws://localhost in development. Default false. */
  allowInsecureLocalhost?: boolean;
  log?: Logger;
  redactor?: Redactor;
}

export interface SocketEvents<In> {
  state: ConnectionState;
  /** Authenticated (after every (re)connect). */
  ready: In;
  /** Every frame after `ready`, except ones already seen (seq ≤ lastSeq). */
  frame: In;
  /** The server revoked the session: the socket stays closed until connect() is called again. */
  revoked: { code: number };
  error: HainivaAgentError;
}

const OPEN = 1;

/**
 * A WebSocket that stays connected: exponential backoff with jitter, auth in the
 * first frame (the token is never in the URL), heartbeat with a dead-connection
 * timeout, and a resume hook carrying the last sequence number seen. Frame shapes
 * are the caller's: pass `authFrame`, `isReady`, `resume`, `seqOf` for the
 * protocol (`/agent/v1/ws` bindings: TODO(S3b)).
 */
export class ReconnectingSocket<In = AnyFrame, Out = AnyFrame> {
  readonly events: TypedEmitter<SocketEvents<In>>;
  private ws: WebSocketLike | null = null;
  private st: ConnectionState = "idle";
  private want = false;
  private authed = false;
  private attempt = 0;
  private seq = 0;
  private lastFrameAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly WS: WebSocketCtor | undefined;
  private readonly redactor: Redactor;
  private readonly log: Logger;
  private readonly expiredCode: number;
  private readonly revokedCode: number;

  constructor(private readonly o: SocketOptions<In, Out>) {
    this.WS = o.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    this.redactor = o.redactor ?? new Redactor();
    this.log = safeLogger(o.log, this.redactor);
    this.events = new TypedEmitter<SocketEvents<In>>((e) => this.log("listener_error", e));
    this.expiredCode = o.closeCodes?.tokenExpired ?? 4001;
    this.revokedCode = o.closeCodes?.revoked ?? 4003;
  }

  get state(): ConnectionState { return this.st; }
  /** The highest sequence number received (what `resume` is called with). */
  get lastSeq(): number { return this.seq; }
  /** Restore a sequence number kept from an earlier run. */
  setLastSeq(n: number): void { if (Number.isFinite(n) && n >= 0) this.seq = n; }

  connect(): void {
    this.want = true;
    if (this.ws || this.reconnectTimer) return;
    if (!this.WS) { this.fail(new HainivaAgentError(0, "no_websocket")); return; }
    void this.open();
  }

  disconnect(): void {
    this.want = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    ws?.close(1000);
    this.setState("closed");
  }

  /** Send a frame on an authenticated socket. False when not open (nothing is queued). */
  send(frame: Out): boolean {
    if (!this.ws || !this.authed || this.ws.readyState !== OPEN) return false;
    this.ws.send(this.encode(frame));
    return true;
  }

  /** Hand a refreshed access token to the open socket (needs `tokenFrame`). */
  updateToken(token: string): boolean {
    this.redactor.add(token);
    return this.o.tokenFrame ? this.send(this.o.tokenFrame(token)) : false;
  }

  private encode(f: Out): string { return (this.o.encode ?? JSON.stringify)(f); }

  private setState(s: ConnectionState): void {
    if (this.st === s) return;
    this.st = s;
    this.events.emit("state", s);
  }

  private fail(e: HainivaAgentError): void {
    this.log("socket_error", { code: e.code });
    this.events.emit("error", e);
  }

  private async open(): Promise<void> {
    this.setState(this.attempt ? "reconnecting" : "connecting");
    let token: string;
    let url: string;
    try {
      token = await this.o.getToken();
      this.redactor.add(token);
      url = typeof this.o.url === "function" ? await this.o.url() : this.o.url;
    } catch (e) {
      this.fail(HainivaAgentError.from(e, "socket_auth_failed", this.redactor));
      return this.scheduleReconnect();
    }
    if (!this.want) return;
    try {
      assertSafeUrl(url, { kind: "ws", ...(this.o.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}) });
      if (token && url.includes(token)) throw new HainivaAgentError(0, "credentials_in_url");
    } catch (e) {
      // A configuration mistake: retrying cannot fix it.
      this.want = false;
      this.setState("closed");
      return this.fail(HainivaAgentError.from(e, "invalid_url", this.redactor));
    }
    let ws: WebSocketLike;
    try { ws = new this.WS!(url); }
    catch (e) { this.fail(HainivaAgentError.from(e, "socket_failed", this.redactor)); return this.scheduleReconnect(); }
    this.ws = ws;
    this.authed = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // First frame: the credential. Nothing else is sent before the server says ready.
      ws.send(this.encode((this.o.authFrame ?? ((t: string) => ({ type: "auth", token: t }) as Out))(token)));
      this.authTimer = setTimeout(() => {
        if (this.ws === ws && !this.authed) { this.log("auth_timeout"); ws.close(4000, "auth timeout"); }
      }, this.o.authTimeoutMs ?? 10_000);
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.onFrame(ws, typeof ev.data === "string" ? ev.data : String(ev.data)); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.authed = false;
      this.clearTimers();
      this.log("socket_closed", { code: ev.code });
      if (!this.want) return this.setState("closed");
      if (ev.code === this.revokedCode) {
        this.want = false;
        this.setState("closed");
        this.events.emit("revoked", { code: ev.code });
        return;
      }
      if (this.o.closeCodes?.fatal?.includes(ev.code)) {
        this.want = false;
        this.setState("closed");
        return this.fail(new HainivaAgentError(0, `socket_closed_${ev.code}`, {}, this.redactor));
      }
      if (ev.code === this.expiredCode) this.o.onTokenRejected?.();
      this.scheduleReconnect();
    };
  }

  private onFrame(ws: WebSocketLike, raw: string): void {
    let f: In;
    try { f = (this.o.decode ?? JSON.parse)(raw) as In; } catch { return; }
    this.lastFrameAt = Date.now();
    if (!this.authed) {
      const ready = this.o.isReady ?? ((x: In) => (x as AnyFrame)?.["type"] === "ready");
      if (!ready(f)) return; // nothing is delivered before the server accepted the credential
      this.authed = true;
      this.attempt = 0;
      if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
      this.startHeartbeat(ws);
      this.setState("open");
      const resume = this.seq > 0 ? this.o.resume?.(this.seq) : null;
      if (resume) ws.send(this.encode(resume));
      this.events.emit("ready", f);
      return;
    }
    const seqOf = this.o.seqOf ?? ((x: In) => { const s = (x as AnyFrame)?.["seq"]; return typeof s === "number" ? s : undefined; });
    const s = seqOf(f);
    if (s !== undefined) {
      if (s <= this.seq) return; // a replayed frame already delivered
      this.seq = s;
    }
    this.events.emit("frame", f);
  }

  private startHeartbeat(ws: WebSocketLike): void {
    const hb = this.o.heartbeat;
    if (hb === false) return;
    const every = hb?.intervalMs ?? 20_000;
    const dead = hb?.timeoutMs ?? 45_000;
    const frame = hb?.frame ?? (() => ({ type: "ping" }) as Out);
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return;
      if (Date.now() - this.lastFrameAt > dead) { this.log("heartbeat_timeout"); ws.close(4000, "heartbeat timeout"); return; }
      if (ws.readyState === OPEN) ws.send(this.encode(frame()));
    }, every);
  }

  private scheduleReconnect(): void {
    if (!this.want) return;
    const b = this.o.backoff;
    const d = backoffDelay(this.attempt++, b?.initialMs, b?.maxMs, b?.random);
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (this.want) void this.open(); }, d);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}
