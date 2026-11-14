/**
 * @hainiva/agent-sdk — build your own agent app on HAINIVA AICC: staff sign-in
 * with your backend's assertion, the live event stream, and calls.
 *
 * Entry points:
 *   "@hainiva/agent-sdk"              transport-agnostic core (this file) — no LiveKit, no DOM, no React Native
 *   "@hainiva/agent-sdk/web"          localStorage store (opt-in), LiveKit call media
 *   "@hainiva/agent-sdk/react-native" secure-store session, LiveKit call media
 *   "@hainiva/agent-sdk/embed"        the embeddable desk (not yet available)
 *
 * Start with HainivaAgent (./agent): it wires the session, the REST client,
 * the event socket and the call state machine together. The parts are exported
 * too, for apps that want their own wiring.
 */

export const SDK_VERSION = "0.2.0";

export { HainivaAgentError } from "./errors.js";
export { Redactor, redactString, redactValue } from "./redact.js";
export { safeLogger, type Logger } from "./log.js";
export { assertSafeUrl, type UrlRules } from "./url.js";
export { TypedEmitter } from "./emitter.js";
export { singleFlight, createTokenRefresher, type RefreshedToken, type TokenRefresher, type TokenRefresherOptions } from "./singleFlight.js";
export {
  SessionManager, memoryStore,
  type AgentSession, type GetAssertion, type SessionEvents, type SessionManagerOptions, type SessionStore, type SessionTransport,
} from "./session.js";
export {
  ReconnectingSocket, backoffDelay,
  type ConnectionState, type SocketEvents, type SocketOptions, type WebSocketCtor, type WebSocketLike,
} from "./ws.js";
export {
  CallStore, transition, activeCall, ringingCalls, initialCallsState,
  type Call, type CallDirection, type CallEffect, type CallEvent, type CallInfo, type CallPath, type CallPhase,
  type CallsState, type CallStoreEvents, type CallStoreOptions, type EndReason, type Transition, type TransferState, type TransferTarget,
} from "./calls.js";
export { HainivaAgent, type HainivaAgentEvents, type HainivaAgentOptions, type JoinMedia, type MediaSession } from "./agent.js";
export {
  AgentRestClient, errorFromResponse, newIdempotencyKey,
  type AgentRestOptions, type AgentStatus, type CallTransferTarget, type ConversationListQuery, type MediaCredentials, type RequestOptions, type TokenSource,
} from "./rest.js";
export {
  AGENT_CLOSE_CODES, agentSocketBindings, isEventFrame, ringInfo, toCallEvents,
  type AgentClientFrame, type AgentEventFrame, type AgentServerFrame,
} from "./events.js";
export * from "./contract.js";
