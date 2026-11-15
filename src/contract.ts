/**
 * GENERATED from the HAINIVA monorepo (@aicc/types agentApi.ts and
 * agentEvents.ts) — do not edit by hand. The Agent API's response shapes and
 * event names: additive changes only within a major version.
 */
/* eslint-disable */

export type AgentPresenceStatus = "online" | "busy" | "away" | "offline";
export type AgentRole = "agent" | "supervisor";

export interface AgentMeDto {
  id: string;
  externalId: string | null;
  displayName: string | null;
  role: AgentRole;
  /** Team ids this member works in; null = the whole organisation. */
  teams: string[] | null;
  status: AgentPresenceStatus | null;
  session: { id: string; agentAppId: string; mode: "live" | "test"; expiresAt: string };
}

export interface AgentRingDto {
  callId: string;
  conversationId: string;
  kind: "voice" | "video" | "chat";
  channel: string;
  contactName: string | null;
  callerNumber: string | null;
  /** direct = routed to you; queue = offered to your queue; escalation = a live call handed to you. */
  path: "direct" | "queue" | "escalation";
  startedAt: string;
}

export interface AgentCallDto {
  callId: string;
  conversationId: string;
  kind: "voice" | "video" | "chat";
  channel: string;
  direction: "inbound" | "outbound" | "internal";
  status: string;
  assignedToMe: boolean;
  startedAt: string;
  endedAt: string | null;
  contactName: string | null;
  callerNumber: string | null;
}

export interface AgentMediaTokenDto { token: string; roomName: string; livekitUrl: string; expiresAt: string }

export interface AgentConversationDto {
  id: string;
  status: string;
  subject: string | null;
  channel: string | null;
  chatType: string | null;
  contact: { id: string; name: string | null; phone: string | null };
  assignedAgentId: string | null;
  assignedToMe: boolean;
  queueId: string | null;
  /** The open interaction a message or file goes to (null when none is open). */
  activeInteractionId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface AgentMessageDto {
  id: string;
  conversationId: string;
  interactionId: string;
  direction: string;
  senderType: string;
  /** agents.id of the sender when an agent wrote it. */
  senderAgentId: string | null;
  senderName: string | null;
  type: string;
  text: string | null;
  attachment: { name: string | null; mimeType: string | null; size: number | null } | null;
  createdAt: string;
}

export interface AgentDispositionDto { code: string; label: string; channel: string | null; required: boolean }

export interface SupervisorLiveCallDto {
  callId: string;
  conversationId: string;
  agentId: string | null;
  agentName: string | null;
  channel: string;
  status: string;
  startedAt: string;
  contactName: string | null;
  callerNumber: string | null;
  queueId: string | null;
}

export interface SupervisorAgentDto {
  id: string;
  displayName: string;
  externalId: string | null;
  role: AgentRole;
  teamId: string | null;
  status: AgentPresenceStatus;
  activeCalls: number;
  openConversations: number;
}

export interface AgentPage<T> { data: T[]; nextCursor: string | null }

// ── Partner platform S3: shapes the SDK binds to (stable, additive only) ──────

/** POST /agent/v1/sessions (201) and POST /agent/v1/sessions/refresh (200). */
export interface AgentSessionDto {
  accessToken: string;
  accessExpiresAt: string;
  /** hnv_rt_…, rotating: each refresh answers a new one and the old one stops working. */
  refreshToken: string;
  refreshExpiresAt: string;
  sessionId: string;
  member: { id: string; externalId: string | null; displayName: string; role: AgentRole };
  app: { id: string; name: string; mode: "live" | "test" };
  /** The event socket on the host the app reached; SDKs derive their own from their base URL. */
  wsUrl: string;
}

/**
 * POST /agent/v1/desk-session (201) — partner platform S4, the embeddable desk.
 * A 15-minute token for the HAINIVA desk shown inside the partner's product,
 * handed to the desk over postMessage only (never in a URL, never stored).
 * Bound to the agent session it came from: ends when that session ends.
 */
export interface AgentDeskSessionDto { token: string; expiresAt: string }

/** POST /agent/v1/calls/:id/accept. `media` is null for a call without a room (chat). */
export interface AgentAcceptDto { callId: string; accepted: true; media: AgentMediaTokenDto | null }

/** POST /agent/v1/supervisor/calls/:id/supervise. */
export interface SupervisorSuperviseDto { callId: string; mode: "monitor" | "whisper" | "barge"; media: AgentMediaTokenDto }

/** POST /agent/v1/push/subscriptions body. */
export interface AgentPushSubscriptionInput {
  platform: "ios" | "android";
  /** FCM registration token (Android) or APNs device token, hex (iPhone). */
  token: string;
  /** voip = rings (PushKit on iPhone, high-priority data on Android); alert = ordinary notices. */
  kind: "voip" | "alert";
  /** Must be one of the agent app's allowedBundleIds. */
  bundleId: string;
  /** A stable id for this install: a new token from the same install replaces the old one. */
  deviceId?: string;
}

/** POST /agent/v1/push/subscriptions (201). The token is never echoed. */
export interface AgentPushSubscriptionDto {
  id: string;
  platform: "ios" | "android";
  kind: "voip" | "alert";
  bundleId: string;
  /** Whether the agent app has working push credentials for this platform right now. */
  deliverable: boolean;
  createdAt: string;
}

/** Event data of the stream's call.ringing. */
export interface AgentCallRingingData {
  callId: string;
  conversationId: string;
  path: "direct" | "queue" | "transfer";
  channel?: string | null;
  line?: string | null;
  contactName: string | null;
  callerNumber?: string | null;
  fromAgentId?: string | null;
  fromAgentName?: string | null;
  transferMode?: "warm" | "blind";
  /** ISO time the ring ends, when the server knows it. */
  expiresAt: string | null;
}

/** Event data of the stream's call.ended. callId is null when only the conversation is known. */
export interface AgentCallEndedData {
  callId: string | null;
  conversationId: string | null;
  reason: "ended" | "failed" | "answered_elsewhere" | "declined" | "expired" | "transfer_ended";
  answeredBy?: string | null;
  failure?: { reason: string };
}

// ── The event stream (/agent/v1/ws) ──────────────────────────────────────────

export const AGENT_EVENT_NAMES = [
  "call.ringing", "call.ended", "conversation.assigned", "message.created",
  "wrapup.required", "presence.changed", "supervisor.alert", "call.supervised",
] as const;
export type AgentEventName = (typeof AGENT_EVENT_NAMES)[number];

export interface AgentEvent { event: AgentEventName; data: Record<string, unknown> }

/** What the stream delivers: the event plus its position (resume from it). */
export interface AgentStreamFrame extends AgentEvent { type: "event"; seq: number; at: string }
