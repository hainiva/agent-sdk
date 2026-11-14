/**
 * @hainiva/agent-sdk/embed — the HAINIVA desk inside your web product.
 *
 *   import { HainivaAgent } from "@hainiva/agent-sdk";
 *   import { mountDesk } from "@hainiva/agent-sdk/embed";
 *
 *   const agent = new HainivaAgent({ baseUrl: "https://api.hainiva.com", tenantId, getAssertion });
 *   await agent.connect();
 *   const desk = mountDesk(document.getElementById("desk")!, {
 *     agent, appId: "<your agent app id>", baseUrl: "https://app.hainiva.com",
 *     onEnded: (reason) => showSignedOut(reason),
 *   });
 *   // later: desk.setTheme("dark"); desk.destroy();
 *
 * Your staff member is signed in with YOUR agent session: the SDK exchanges it
 * for a 15-minute desk token (POST /agent/v1/desk-session) and hands that to
 * the desk over postMessage — never in the URL, never stored. The desk asks
 * for a fresh one before it expires; when the session ends (signed out,
 * suspended, app paused) the desk shows "ended" and `onEnded` fires.
 *
 * Your page's origin must be in the agent app's `allowedOrigins`: that list is
 * also the desk's CSP frame-ancestors, so any other site gets a blank frame.
 *
 * Security, both directions:
 *   - only messages whose `event.source` is THIS iframe's window and whose
 *     `event.origin` is the HAINIVA desk origin are read, and only in the exact
 *     message shapes below;
 *   - everything we send goes to the desk origin only (never "*").
 */
import type { AgentDeskSessionDto } from "./contract.js";
import { HainivaAgentError } from "./errors.js";
import { assertSafeUrl } from "./url.js";

// ── The protocol (shared by the web iframe and the React Native WebView) ─────

export type DeskEndReason =
  | "not_embedded" | "no_host" | "expired" | "revoked" | "host_ended" | "misconfigured"
  /** The desk never answered (wrong origin: the CSP blocked the frame; network). */
  | "load_failed"
  /** Your agent session could not provide a desk token. */
  | "session_ended";

/** From the desk. */
export type DeskToHost =
  | { v: 1; type: "hainiva:ready"; appId: string }
  | { v: 1; type: "hainiva:token-request"; reason: "expiring" | "unauthorized" }
  | { v: 1; type: "hainiva:ended"; reason: Exclude<DeskEndReason, "load_failed" | "session_ended"> }
  | { v: 1; type: "hainiva:dial"; number: string; contactId?: string }
  | { v: 1; type: "hainiva:dialer"; number?: string; contactId?: string }
  | { v: 1; type: "hainiva:open-url"; url: string }
  | { v: 1; type: "hainiva:media-error"; name: string };

/** To the desk. */
export type HostToDesk =
  | { v: 1; type: "hainiva:token"; token: string; expiresAt: string }
  | { v: 1; type: "hainiva:theme"; mode: "light" | "dark" }
  | { v: 1; type: "hainiva:locale"; locale: "vi" | "en" }
  | { v: 1; type: "hainiva:end" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const END_REASONS = new Set(["not_embedded", "no_host", "expired", "revoked", "host_ended", "misconfigured"]);
const PHONE = /^[0-9+*#() .-]{1,40}$/;

function keysAre(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const k = Object.keys(o);
  return required.every((r) => k.includes(r)) && k.every((x) => required.includes(x) || optional.includes(x));
}
const optId = (v: unknown) => v === undefined || (typeof v === "string" && UUID.test(v));

/** Exactly one of the desk's messages, or null. */
export function parseDeskMessage(data: unknown): DeskToHost | null {
  let d = data;
  if (typeof d === "string") { if (d.length > 8192) return null; try { d = JSON.parse(d); } catch { return null; } }
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const o = d as Record<string, unknown>;
  if (o["v"] !== 1) return null;
  switch (o["type"]) {
    case "hainiva:ready":
      return keysAre(o, ["v", "type", "appId"]) && typeof o["appId"] === "string" && UUID.test(o["appId"]) ? { v: 1, type: "hainiva:ready", appId: o["appId"] } : null;
    case "hainiva:token-request":
      return keysAre(o, ["v", "type", "reason"]) && (o["reason"] === "expiring" || o["reason"] === "unauthorized") ? { v: 1, type: "hainiva:token-request", reason: o["reason"] } : null;
    case "hainiva:ended":
      return keysAre(o, ["v", "type", "reason"]) && typeof o["reason"] === "string" && END_REASONS.has(o["reason"])
        ? { v: 1, type: "hainiva:ended", reason: o["reason"] as Exclude<DeskEndReason, "load_failed" | "session_ended"> } : null;
    case "hainiva:dial":
      if (!keysAre(o, ["v", "type", "number"], ["contactId"]) || typeof o["number"] !== "string" || !PHONE.test(o["number"]) || !optId(o["contactId"])) return null;
      return { v: 1, type: "hainiva:dial", number: o["number"], ...(o["contactId"] ? { contactId: o["contactId"] as string } : {}) };
    case "hainiva:dialer":
      if (!keysAre(o, ["v", "type"], ["number", "contactId"]) || !optId(o["contactId"])) return null;
      if (o["number"] !== undefined && (typeof o["number"] !== "string" || !PHONE.test(o["number"]))) return null;
      return { v: 1, type: "hainiva:dialer", ...(o["number"] ? { number: o["number"] as string } : {}), ...(o["contactId"] ? { contactId: o["contactId"] as string } : {}) };
    case "hainiva:open-url": {
      if (!keysAre(o, ["v", "type", "url"]) || typeof o["url"] !== "string" || o["url"].length > 2048) return null;
      let u: URL;
      try { u = new URL(o["url"]); } catch { return null; }
      return ["https:", "http:", "mailto:", "tel:"].includes(u.protocol) ? { v: 1, type: "hainiva:open-url", url: u.href } : null;
    }
    case "hainiva:media-error":
      return keysAre(o, ["v", "type", "name"]) && typeof o["name"] === "string" && o["name"].length <= 60 ? { v: 1, type: "hainiva:media-error", name: o["name"] } : null;
    default:
      return null;
  }
}

/** Where the desk token comes from: `HainivaAgent` (its `desk.session()`), or anything shaped like it. */
export interface DeskTokenSource { desk: { session(): Promise<AgentDeskSessionDto> } }

export interface DeskCallbacks {
  /** The desk wants to place a call (React Native: your native call; web: the desk calls itself and never sends this). */
  onDial?: (number: string, contactId?: string) => void;
  /** Open your dialer, optionally pre-filled. */
  onDialer?: (prefill: { number?: string; contactId?: string }) => void;
  /** The desk's session is over. Show your own signed-out state; mount again after a new sign-in. */
  onEnded?: (reason: DeskEndReason) => void;
  /** A link the desk cannot open itself (React Native). Default: ignored. */
  onOpenUrl?: (url: string) => void;
  /** The microphone/camera was refused (web): check your iframe's `allow` and the browser's permission. */
  onMediaError?: (name: string) => void;
}

/**
 * The host side of the desk protocol, transport-agnostic: `mountDesk` (iframe)
 * and `<HainivaDesk/>` (React Native WebView) both drive one.
 * @internal exported for the React Native entry and tests.
 */
export class DeskHost {
  private ended = false;
  private ready = false;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly appId: string,
    private readonly source: DeskTokenSource,
    private readonly send: (m: HostToDesk) => void,
    private readonly cb: DeskCallbacks,
  ) {}

  get isReady(): boolean { return this.ready; }
  get isEnded(): boolean { return this.ended; }

  /** A raw message from the desk (already origin/source-checked by the transport). */
  receive(raw: unknown): void {
    if (this.ended) return;
    const m = parseDeskMessage(raw);
    if (!m) return;
    switch (m.type) {
      case "hainiva:ready":
        if (m.appId.toLowerCase() !== this.appId.toLowerCase()) return;
        this.ready = true;
        void this.supplyToken();
        return;
      case "hainiva:token-request": void this.supplyToken(); return;
      case "hainiva:ended": this.finish(m.reason, false); return;
      case "hainiva:dial": this.cb.onDial?.(m.number, m.contactId); return;
      case "hainiva:dialer": this.cb.onDialer?.({ ...(m.number ? { number: m.number } : {}), ...(m.contactId ? { contactId: m.contactId } : {}) }); return;
      case "hainiva:open-url": this.cb.onOpenUrl?.(m.url); return;
      case "hainiva:media-error": this.cb.onMediaError?.(m.name); return;
    }
  }

  /** One desk-session request at a time; the token goes to the desk only. */
  supplyToken(): Promise<void> {
    if (this.ended) return Promise.resolve();
    this.inflight ??= (async () => {
      try {
        const d = await this.source.desk.session();
        if (!this.ended) this.send({ v: 1, type: "hainiva:token", token: d.token, expiresAt: d.expiresAt });
      } catch (e) {
        // A final refusal of the agent session: the desk ends with it. A
        // transient failure: the desk asks again (or ends on its own timeout).
        const final = e instanceof HainivaAgentError && (e.status === 401 || e.status === 403);
        if (final) this.finish("session_ended", true);
      } finally { this.inflight = null; }
    })();
    return this.inflight;
  }

  setTheme(mode: "light" | "dark"): void { if (mode === "light" || mode === "dark") this.send({ v: 1, type: "hainiva:theme", mode }); }
  setLocale(locale: "vi" | "en"): void { if (locale === "vi" || locale === "en") this.send({ v: 1, type: "hainiva:locale", locale }); }

  finish(reason: DeskEndReason, tellDesk: boolean): void {
    if (this.ended) return;
    if (tellDesk) { try { this.send({ v: 1, type: "hainiva:end" }); } catch { /* gone */ } }
    this.ended = true;
    this.cb.onEnded?.(reason);
  }
}

/** The desk page for an app. The URL carries the app id ONLY. */
export function deskUrl(baseUrl: string, appId: string, opts: { allowInsecureLocalhost?: boolean } = {}): URL {
  if (!UUID.test(appId)) throw new HainivaAgentError(0, "invalid_id", { field: "appId" });
  const base = assertSafeUrl(baseUrl, { kind: "http", ...(opts.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}) });
  const u = new URL("/embed", base.origin);
  u.searchParams.set("app", appId.toLowerCase());
  return u;
}

// ── Web: the iframe ──────────────────────────────────────────────────────────

/**
 * The iframe's sandbox — every flag the desk needs and nothing more:
 *   allow-scripts                 the desk is an application;
 *   allow-same-origin             the desk keeps ITS OWN origin (app.hainiva.com):
 *                                 its same-origin API calls, its session storage
 *                                 and the gateway's Origin check depend on it. It
 *                                 gives the desk no access to your page — that is
 *                                 a different origin;
 *   allow-forms                   the composer and every dialog submit forms;
 *   allow-popups                  links, recordings and help open in a new tab…
 *   allow-popups-to-escape-sandbox …as normal pages, not sandboxed copies;
 *   allow-downloads               call recordings, attachments, exports;
 *   allow-modals                  the desk confirms destructive actions (confirm()).
 * Deliberately NOT: allow-top-navigation(-by-user-activation) — the desk can
 * never navigate your page; allow-pointer-lock, allow-presentation,
 * allow-orientation-lock, allow-storage-access-by-user-activation.
 */
export const DESK_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";
/** Calls in the iframe are WebRTC: the microphone (and camera for video) must be delegated. */
export const DESK_ALLOW = "microphone; camera; autoplay; clipboard-write";

export interface MountDeskOptions extends DeskCallbacks {
  /** A connected HainivaAgent (or anything with `desk.session()`). */
  agent: DeskTokenSource;
  /** Your agent app id (its allowedOrigins must list this page's origin). */
  appId: string;
  /** The HAINIVA desk, e.g. https://app.hainiva.com. */
  baseUrl: string;
  theme?: "light" | "dark";
  locale?: "vi" | "en";
  /** The iframe's accessible title. Default "HAINIVA". */
  title?: string;
  /** No `hainiva:ready` within this long = onEnded("load_failed"). Default 20 s. */
  loadTimeoutMs?: number;
  /** Local development only (http://localhost desk). */
  allowInsecureLocalhost?: boolean;
}

export interface MountedDesk {
  /** Remove the desk (it is told to drop its token first). */
  destroy(): void;
  setTheme(mode: "light" | "dark"): void;
  setLocale(locale: "vi" | "en"): void;
  /** The iframe, for sizing. */
  readonly iframe: HTMLIFrameElement;
}

interface ContainerLike { appendChild(n: unknown): unknown; ownerDocument?: Document | null }

/** Show the HAINIVA desk in `container`, signed in as your agent session's staff member. */
export function mountDesk(container: ContainerLike, o: MountDeskOptions): MountedDesk {
  if (!container || typeof container.appendChild !== "function") throw new HainivaAgentError(0, "invalid_container", {});
  if (!o?.agent?.desk || typeof o.agent.desk.session !== "function") throw new HainivaAgentError(0, "invalid_agent", {});
  const url = deskUrl(o.baseUrl, o.appId, o.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {});
  const deskOrigin = url.origin;
  const doc = container.ownerDocument ?? (globalThis as { document?: Document }).document;
  const win = (doc?.defaultView ?? globalThis) as unknown as Window;
  if (!doc) throw new HainivaAgentError(0, "no_document", {});
  if (win.location?.origin === deskOrigin) throw new HainivaAgentError(0, "same_origin_host", { origin: deskOrigin });

  const iframe = doc.createElement("iframe");
  iframe.setAttribute("sandbox", DESK_SANDBOX);
  iframe.setAttribute("allow", DESK_ALLOW);
  iframe.setAttribute("title", o.title ?? "HAINIVA");
  iframe.setAttribute("referrerpolicy", "origin");
  iframe.style.border = "0";
  iframe.style.width = "100%";
  iframe.style.height = "100%";

  const host = new DeskHost(o.appId, o.agent, (m) => { iframe.contentWindow?.postMessage(m, deskOrigin); }, {
    ...o,
    onEnded: (r) => { clearTimeout(loadTimer); o.onEnded?.(r); },
  });

  const onMessage = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow || e.origin !== deskOrigin) return;
    const wasReady = host.isReady;
    host.receive(e.data);
    if (!wasReady && host.isReady) {
      clearTimeout(loadTimer);
      if (o.theme) host.setTheme(o.theme);
      if (o.locale) host.setLocale(o.locale);
    }
  };
  win.addEventListener("message", onMessage);
  const loadTimer = setTimeout(() => { if (!host.isReady) host.finish("load_failed", false); }, o.loadTimeoutMs ?? 20_000);

  iframe.setAttribute("src", url.href);
  container.appendChild(iframe);

  return {
    iframe,
    setTheme: (m) => host.setTheme(m),
    setLocale: (l) => host.setLocale(l),
    destroy: () => {
      clearTimeout(loadTimer);
      if (!host.isEnded) { try { iframe.contentWindow?.postMessage({ v: 1, type: "hainiva:end" }, deskOrigin); } catch { /* gone */ } }
      win.removeEventListener("message", onMessage);
      iframe.remove();
    },
  };
}
