/**
 * HainivaAgent — one object for a staff member's app: sign-in with your
 * backend's assertion, the REST API, the live event socket and the agent's
 * calls, wired together.
 *
 *   const agent = new HainivaAgent({ baseUrl, tenantId, getAssertion, media: joinCallRoom });
 *   agent.on("call.ringing", (r) => showRing(r));
 *   await agent.connect();
 *   await agent.calls.accept(callId);   // answers, then joins the room with `media`
 *
 * Transport-agnostic: LiveKit, the DOM and React Native come in through options
 * (`media`, `WebSocket`, `store`), so the core runs in Node too.
 */
import { CallStore, type CallEffect, type CallsState, type TransferTarget } from "./calls.js";
import type {
  AgentAcceptDto, AgentCallEndedData, AgentCallRingingData, AgentConversationDto, AgentDispositionDto, AgentMeDto,
  AgentMessageDto, AgentPage, AgentPushSubscriptionDto, AgentPushSubscriptionInput, AgentRingDto, AgentSessionDto,
  SupervisorAgentDto, SupervisorLiveCallDto, SupervisorSuperviseDto,
} from "./contract.js";
import { TypedEmitter } from "./emitter.js";
import { HainivaAgentError } from "./errors.js";
import { agentSocketBindings, isEventFrame, isKnownEvent, toCallEvents, type AgentClientFrame, type AgentEventFrame, type AgentServerFrame } from "./events.js";
import { safeLogger, type Logger } from "./log.js";
import { Redactor } from "./redact.js";
import { AgentRestClient, type AgentStatus, type ConversationListQuery, type MediaCredentials, type RequestOptions } from "./rest.js";
import { SessionManager, type AgentSession, type GetAssertion, type SessionStore } from "./session.js";
import { ReconnectingSocket, type ConnectionState, type WebSocketCtor } from "./ws.js";

/** A joined media room — what `joinCallRoom` from `/web` or `/react-native` returns. */
export interface MediaSession {
  leave(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  onDisconnected(fn: () => void): () => void;
}
/** Join a room: pass `joinCallRoom` from `@hainiva/agent-sdk/web` or `/react-native`. */
export type JoinMedia = (join: { url: string; token: string }) => Promise<MediaSession>;

export interface HainivaAgentOptions {
  /** https://api.hainiva.com (or your organisation's API host). */
  baseUrl: string;
  tenantId: string;
  /** Ask YOUR backend for a fresh assertion — every time; never cache one. */
  getAssertion: GetAssertion;
  /** Where the session is kept. Default in memory (a restart signs in again). */
  store?: SessionStore;
  /** Joins call media. Without it, `calls.accept` answers and returns the credentials only. */
  media?: JoinMedia;
  /** WebSocket implementation (browsers and React Native have one; Node 22 too). */
  WebSocket?: WebSocketCtor;
  fetch?: typeof fetch;
  device?: { label?: string; platform?: "ios" | "android" | "web" | "other" };
  /** Per REST request. Default 15 s. */
  timeoutMs?: number;
  /** How long a ring with no server-known end may ring here. Default 60 s. */
  ringTimeoutMs?: number;
  /** A redacted log of what the SDK does. Nothing is logged without it. */
  log?: Logger;
  /** Local development only (http://localhost, ws://localhost). */
  allowInsecureLocalhost?: boolean;
}

export interface HainivaAgentEvents {
  /** Socket state. */
  connection: ConnectionState;
  /** The socket is authenticated (after every reconnect). */
  ready: { seq: number };
  "call.ringing": AgentCallRingingData;
  "call.ended": AgentCallEndedData;
  "conversation.assigned": Record<string, unknown>;
  "message.created": Record<string, unknown>;
  "wrapup.required": { callId: string; conversationId: string; deadlineAt: string | null };
  "presence.changed": Record<string, unknown>;
  "supervisor.alert": Record<string, unknown>;
  /** An event name this SDK version does not know yet (the server added one). */
  "event.unknown": AgentEventFrame;
  /** The calls changed (state machine). */
  calls: CallsState;
  /** Something the host must do for a call (stop the native ring, leave media). Handled for media already. */
  callEffect: CallEffect;
  /** Events were missed beyond what the server keeps: state was refetched (rings); refetch your own lists. */
  resync: { fromSeq: number };
  /** The session expires within a minute: the SDK is refreshing it. */
  "session.expiring": { expiresAt: string };
  /** The session was ended by HAINIVA (sign-out elsewhere, suspended, app paused, key rotated). Call connect() to sign in again. */
  revoked: { reason: string };
  error: HainivaAgentError;
}

/**
 * The staff member's app: session, REST, socket and calls.
 */
export class HainivaAgent {
  readonly events: TypedEmitter<HainivaAgentEvents>;
  readonly session: SessionManager<AgentSession & AgentSessionDto>;
  readonly rest: AgentRestClient;
  readonly callStore: CallStore;
  private socket: ReconnectingSocket<AgentServerFrame, AgentClientFrame> | null = null;
  private meDto: AgentMeDto | null = null;
  private readonly media = new Map<string, MediaSession>();
  private readonly offs: (() => void)[] = [];
  private readonly redactor: Redactor;
  private readonly log: Logger;
  private readonly ringMs: number;

  constructor(private readonly o: HainivaAgentOptions) {
    this.redactor = new Redactor();
    this.log = safeLogger(o.log, this.redactor);
    this.events = new TypedEmitter<HainivaAgentEvents>((e) => this.log("listener_error", e));
    this.ringMs = o.ringTimeoutMs ?? 60_000;
    this.rest = new AgentRestClient({
      baseUrl: o.baseUrl, tenantId: o.tenantId, redactor: this.redactor,
      ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.device ? { device: o.device } : {}), ...(o.log ? { log: o.log } : {}),
      ...(o.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}),
    });
    this.session = new SessionManager({
      getAssertion: o.getAssertion, transport: this.rest.sessions, redactor: this.redactor,
      ...(o.store ? { store: o.store } : {}), ...(o.log ? { log: o.log } : {}),
    });
    this.rest.useTokens(this.session);
    this.callStore = new CallStore();
    this.callStore.events.on("change", (s) => this.events.emit("calls", s));
    this.callStore.events.on("effect", (e) => this.onEffect(e));
  }

  /** The signed-in member (after connect()). */
  get me(): AgentMeDto | null { return this.meDto; }
  /** The calls now (the state machine): ringing, connecting, active, held, ended. */
  get callsState(): CallsState { return this.callStore.state; }
  get connection(): ConnectionState { return this.socket?.state ?? "idle"; }

  on<K extends keyof HainivaAgentEvents>(event: K, fn: (payload: HainivaAgentEvents[K]) => void): () => void {
    return this.events.on(event, fn);
  }

  /** Sign in (or restore the stored session), load who you are and the rings waiting, open the event socket. */
  async connect(): Promise<AgentMeDto> {
    await this.session.signIn();
    this.meDto = await this.guard(this.rest.me());
    if (!this.socket) this.openSocket();
    this.socket!.connect();
    await this.syncRings().catch((e) => this.log("pending_rings_failed", e));
    return this.meDto;
  }

  /**
   * Close the socket and leave every call's media. `signOut: true` also ends
   * the session on the server (and removes it from the store) — do that when
   * the staff member signs out; unregister this device's push first.
   */
  async disconnect(opts: { signOut?: boolean } = {}): Promise<void> {
    this.socket?.disconnect();
    this.socket = null;
    for (const off of this.offs.splice(0)) off();
    await Promise.all([...this.media.values()].map((m) => m.leave().catch(() => undefined)));
    this.media.clear();
    if (opts.signOut) await this.session.signOut();
  }

  setStatus(status: AgentStatus, o?: RequestOptions): Promise<{ status: AgentStatus }> { return this.guard(this.rest.setStatus(status, o)); }

  readonly rings = {
    /** Rings waiting for you now (also fed into the call state). */
    pending: (): Promise<AgentRingDto[]> => this.syncRings(),
  };

  readonly calls = {
    /**
     * Answer: the server's answer race decides (409 = someone else was
     * faster). With `media`, joins the room and returns the session.
     */
    accept: async (callId: string, ring?: { from?: string; conversationId?: string }): Promise<{ accepted: AgentAcceptDto; media: MediaSession | null }> => {
      const known = this.callStore.state.calls[callId];
      if (!known || known.phase === "ended") {
        // Answered from a push (CallKit / the Android call notification) before
        // the socket told us about the ring: the state machine learns it now.
        this.callStore.dispatch({ type: "ring", call: {
          id: callId, direction: "inbound", path: "queue", from: ring?.from ?? "",
          ...(ring?.conversationId ? { conversationId: ring.conversationId } : {}), expiresAt: Date.now() + this.ringMs,
        } });
      }
      this.callStore.dispatch({ type: "accept", id: callId });
      let accepted: AgentAcceptDto;
      try {
        accepted = await this.guard(this.rest.acceptCall(callId));
      } catch (e) {
        const err = HainivaAgentError.from(e, "accept_failed", this.redactor);
        const reason = err.status === 409 ? "answered_elsewhere" : err.status === 404 || err.code === "call_ended" ? "gone" : "failed";
        this.callStore.dispatch({ type: "accept_failed", id: callId, reason, error: err.code });
        throw err;
      }
      if (!accepted.media || !this.o.media) {
        this.callStore.dispatch({ type: "connected", id: callId, answered: true });
        return { accepted, media: null };
      }
      const media = await this.joinMedia(callId, accepted.media);
      return { accepted, media };
    },
    decline: async (callId: string) => {
      this.callStore.dispatch({ type: "decline", id: callId });
      return this.guard(this.rest.declineCall(callId));
    },
    /** Hang up here: media is left at once, then the server ends the call. */
    end: async (callId: string) => {
      this.callStore.dispatch({ type: "hang_up", id: callId });
      return this.guard(this.rest.endCall(callId));
    },
    hold: async (callId: string, on: boolean) => {
      const r = await this.guard(this.rest.holdCall(callId, on));
      this.callStore.dispatch(on ? { type: "hold", id: callId } : { type: "resume", id: callId });
      return r;
    },
    mute: async (callId: string, muted: boolean) => {
      await this.media.get(callId)?.setMuted(muted);
      this.callStore.dispatch({ type: "mute", id: callId, muted });
    },
    /** Warm or blind to a colleague, to a queue (always blind), or to a phone number. */
    transfer: async (callId: string, target: TransferTarget, mode: "warm" | "blind" = "warm") => {
      this.callStore.dispatch({ type: "transfer_start", id: callId, mode, target });
      try {
        return await this.guard(this.rest.transferCall(callId,
          target.kind === "agent" ? { agentId: target.agentId, mode } : target.kind === "queue" ? { queueId: target.queueId } : { number: target.number, mode }));
      } catch (e) {
        this.callStore.dispatch({ type: "transfer_cancelled", id: callId, notice: "transfer_failed" });
        throw e;
      }
    },
    get: (callId: string) => this.guard(this.rest.getCall(callId)),
  };

  /** Join (or re-join) a call's media room. Without credentials, a fresh LiveKit token is minted. */
  async joinMedia(callId: string, creds?: MediaCredentials): Promise<MediaSession> {
    if (!this.o.media) throw new HainivaAgentError(0, "no_media_adapter", { hint: "pass options.media = joinCallRoom from @hainiva/agent-sdk/web or /react-native" });
    const c = creds ?? await this.guard(this.rest.mediaToken(callId));
    this.redactor.add(c.token);
    const previous = this.media.get(callId);
    if (previous) await previous.leave().catch(() => undefined);
    let m: MediaSession;
    try {
      m = await this.o.media({ url: c.livekitUrl, token: c.token });
    } catch (e) {
      this.callStore.dispatch({ type: "accept_failed", id: callId, reason: "failed", error: "media_connect_failed" });
      throw HainivaAgentError.from(e, "media_connect_failed", this.redactor);
    }
    this.media.set(callId, m);
    m.onDisconnected(() => {
      if (this.media.get(callId) !== m) return;
      this.media.delete(callId);
      this.callStore.dispatch({ type: "remote_end", id: callId });
    });
    // Media that comes up after the caller hung up is left at once (the machine's media.leave effect).
    this.callStore.dispatch({ type: "connected", id: callId, answered: true });
    return m;
  }

  readonly conversations = {
    list: (q?: ConversationListQuery): Promise<AgentPage<AgentConversationDto>> => this.guard(this.rest.listConversations(q)),
    get: (id: string) => this.guard(this.rest.getConversation(id)),
    /** Take it yourself (no agentId) or, a supervisor, give it to a colleague. */
    assign: (id: string, agentId?: string) => this.guard(this.rest.assignConversation(id, agentId)),
    release: (id: string, note?: string) => this.guard(this.rest.releaseConversation(id, note)),
    transfer: (id: string, to: { agentId: string } | { queueId: string; note?: string }) => this.guard(this.rest.transferConversation(id, to)),
    close: (id: string) => this.guard(this.rest.closeConversation(id)),
  };

  readonly messages = {
    list: (conversationId: string, q?: { after?: string; limit?: number }): Promise<AgentPage<AgentMessageDto>> => this.guard(this.rest.listMessages(conversationId, q)),
    send: (conversationId: string, text: string) => this.guard(this.rest.sendMessage(conversationId, text)),
    typing: (conversationId: string) => this.guard(this.rest.typing(conversationId)),
  };

  /** After a call: a disposition code from dispositions() and notes. */
  wrapUp(callId: string, w: { dispositionCode?: string; notes?: string } = {}) { return this.guard(this.rest.wrapUp(callId, w)); }
  dispositions(channel?: string): Promise<AgentDispositionDto[]> { return this.guard(this.rest.dispositions(channel)); }

  readonly supervisor = {
    liveCalls: (): Promise<SupervisorLiveCallDto[]> => this.guard(this.rest.liveCalls()),
    agents: (): Promise<SupervisorAgentDto[]> => this.guard(this.rest.teamAgents()),
    /** Listen in (monitor), coach the agent (whisper) or join the call (barge). Join `media` with your adapter. */
    supervise: (callId: string, mode: "monitor" | "whisper" | "barge" = "monitor"): Promise<SupervisorSuperviseDto> => this.guard(this.rest.supervise(callId, mode)),
    setMode: (callId: string, mode: "monitor" | "whisper" | "barge", supervisorTrackSid?: string) => this.guard(this.rest.setSuperviseMode(callId, mode, supervisorTrackSid)),
  };

  readonly push = {
    /** Register this device's FCM token (Android) or PushKit/APNs token (iPhone) for YOUR app's credentials. */
    register: (sub: AgentPushSubscriptionInput): Promise<AgentPushSubscriptionDto> => this.guard(this.rest.registerPush(sub)),
    unregister: (token: string) => this.guard(this.rest.unregisterPush(token)),
  };

  // ── Internals ───────────────────────────────────────────────────────────────

  /** A REST call; a final 401 session_revoked tells the app and forgets the session. */
  private async guard<T>(p: Promise<T>): Promise<T> {
    try { return await p; }
    catch (e) {
      if (e instanceof HainivaAgentError && e.status === 401 && e.code === "session_revoked") await this.onRevoked("session_revoked");
      throw e;
    }
  }

  private async onRevoked(reason: string): Promise<void> {
    this.socket?.disconnect();
    this.socket = null;
    await this.session.clear();
    this.events.emit("revoked", { reason });
  }

  private openSocket(): void {
    let sock: ReconnectingSocket<AgentServerFrame, AgentClientFrame>;
    sock = new ReconnectingSocket<AgentServerFrame, AgentClientFrame>({
      url: this.rest.wsUrl,
      getToken: () => this.session.accessToken(),
      onTokenRejected: () => this.session.invalidate(),
      redactor: this.redactor,
      ...(this.o.WebSocket ? { WebSocket: this.o.WebSocket } : {}),
      ...(this.o.log ? { log: this.o.log } : {}),
      ...(this.o.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}),
      ...agentSocketBindings(() => sock.lastSeq),
    });
    this.socket = sock;
    this.offs.push(
      sock.events.on("state", (s) => this.events.emit("connection", s)),
      sock.events.on("error", (e) => this.events.emit("error", e)),
      sock.events.on("revoked", () => { void this.onRevoked("socket_revoked"); }),
      sock.events.on("ready", (f) => {
        const seq = f.type === "ready" && typeof f.seq === "number" ? f.seq : 0;
        // A first connect starts at the server's newest event: old rings are not replayed.
        if (sock.lastSeq === 0 && seq > 0) sock.setLastSeq(seq);
        this.events.emit("ready", { seq });
      }),
      sock.events.on("frame", (f) => this.onFrame(sock, f)),
      this.session.events.on("token", (t) => { sock.updateToken(t); }),
    );
  }

  private onFrame(sock: ReconnectingSocket<AgentServerFrame, AgentClientFrame>, f: AgentServerFrame): void {
    switch (f.type) {
      case "event": {
        if (!isEventFrame(f)) return;
        for (const ev of toCallEvents(f, this.callStore.state, Date.now(), this.ringMs)) this.callStore.dispatch(ev);
        if (isKnownEvent(f.event)) (this.events.emit as (k: string, p: unknown) => void)(f.event, f.data);
        else this.events.emit("event.unknown", f);
        return;
      }
      case "resync_required": {
        const from = typeof f.fromSeq === "number" && f.fromSeq >= 0 ? f.fromSeq : 0;
        sock.setLastSeq(from);
        void this.syncRings().catch((e) => this.log("pending_rings_failed", e));
        this.events.emit("resync", { fromSeq: from });
        return;
      }
      case "session.expiring":
        this.events.emit("session.expiring", { expiresAt: String(f.expiresAt ?? "") });
        // The server's clock decides: refresh now even if ours thinks there is time.
        // Refreshing emits "token", which hands the new token to this socket (token.refresh).
        this.session.invalidate(this.session.current?.accessToken);
        void this.session.accessToken().catch((e) => this.log("refresh_failed", e));
        return;
      case "ack":
        if (!f.ok) this.log("socket_ack_refused", { error: f.error });
        return;
      default:
        return;
    }
  }

  /** Rings waiting on the server → the call state (a cold start, a missed push, a resync). */
  private async syncRings(): Promise<AgentRingDto[]> {
    const rings = await this.guard(this.rest.pendingRings());
    const now = Date.now();
    for (const r of rings) {
      if (!r || typeof r.callId !== "string") continue;
      this.callStore.dispatch({
        type: "ring",
        call: {
          id: r.callId, conversationId: r.conversationId, direction: "inbound",
          path: r.path === "direct" ? "direct" : "queue",
          from: r.contactName ?? r.callerNumber ?? "", expiresAt: now + this.ringMs,
        },
      });
    }
    return rings;
  }

  private onEffect(e: CallEffect): void {
    if (e.type === "media.leave") {
      const m = this.media.get(e.id);
      this.media.delete(e.id);
      if (m) void m.leave().catch(() => undefined);
    }
    this.events.emit("callEffect", e);
  }
}
