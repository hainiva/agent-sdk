/**
 * Recorded S2 response shapes of the Agent API (api-gateway routes/agentPublic.ts
 * and agentFacade.ts, as exercised by scripts/partner-platform/s2-e2e.sh on
 * staging). Tests only (excluded from the build). A change here is a change
 * of the public contract.
 */
import type { AgentAcceptDto, AgentMeDto, AgentSessionDto } from "../contract.js";

export const BASE = "https://api.example.test";
export const T = "tenant-test";
export const CALL = "3f1c2b9a-1111-4a2b-8c3d-000000000001";
export const CONV = "3f1c2b9a-2222-4a2b-8c3d-000000000002";
export const MEMBER = "3f1c2b9a-3333-4a2b-8c3d-000000000003";
export const APP = "3f1c2b9a-4444-4a2b-8c3d-000000000004";
export const jwt = (n: number) => `eyJhbGciOiJIUzI1NiJ9.eyJzIjoic2Vzc2lvbi0${n}In0.c2lnbmF0dXJl${n}`;
export const future = (s: number) => new Date(Date.now() + s * 1000).toISOString();

export const S2 = {
  session: (n: number): AgentSessionDto => ({
    accessToken: jwt(n), accessExpiresAt: future(900), refreshToken: `hnv_rt_${"r".repeat(20)}${n}`, refreshExpiresAt: future(2_592_000),
    sessionId: "9d0f0000-0000-4000-8000-00000000000a",
    member: { id: MEMBER, externalId: "staff-42", displayName: "Nguyễn Văn A", role: "agent" },
    app: { id: APP, name: "Partner Agent", mode: "live" },
    wsUrl: "wss://api.example.test/agent/v1/ws",
  }),
  me: {
    id: MEMBER, externalId: "staff-42", displayName: "Nguyễn Văn A", role: "agent", teams: [], status: "online",
    session: { id: "9d0f0000-0000-4000-8000-00000000000a", agentAppId: APP, mode: "live", expiresAt: future(900) },
  } satisfies AgentMeDto,
  status: { status: "away" },
  rings: { data: [{ callId: CALL, conversationId: CONV, kind: "voice", channel: "sip_pstn", contactName: "Khách hàng", callerNumber: "090****567", path: "queue", startedAt: future(-5) }] },
  accept: { callId: CALL, accepted: true, media: { token: jwt(99), roomName: "room-1", livekitUrl: "wss://lk.example.test", expiresAt: future(3600) } } satisfies AgentAcceptDto,
  conversations: { data: [{ id: CONV, status: "open", subject: null, channel: "zalo_oa", chatType: null, contact: { id: CONV, name: "Khách", phone: null }, assignedAgentId: MEMBER, assignedToMe: true, queueId: null, activeInteractionId: CALL, lastMessageAt: null, createdAt: future(-60), closedAt: null }], nextCursor: "Y3Vyc29y" },
  dispositions: { data: [{ code: "resolved", label: "Đã xử lý", channel: null, required: false }] },
  errors: {
    tokenExpired: { error: { code: "token_expired", message: "The access token has expired: refresh it" } },
    revoked: { error: { code: "session_revoked", message: "This session has ended. Sign in again." } },
    refreshReused: { error: { code: "refresh_reused", message: "This refresh token was already used" } },
    supervisorOnly: { error: { code: "supervisor_only", message: "Only a supervisor can do this" } },
    notFound: { error: { code: "not_found", message: "Call not found" } },
    upstream: { error: { code: "upstream_error", message: "The service could not answer; retry shortly" } },
  },
};

