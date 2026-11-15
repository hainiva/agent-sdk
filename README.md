# @hainiva/agent-sdk

Build **your own staff app** on [HAINIVA](https://hainiva.com): your staff
sign in with an assertion from your backend, receive their rings and
conversations over one reconnecting socket, and take calls with LiveKit — in a
browser, in React Native, or in Node.

> **Status: 0.x preview.** The API may change in a minor release until 1.0.

| Import | What | Needs |
| --- | --- | --- |
| `@hainiva/agent-sdk` | `HainivaAgent`, the REST client, the socket, the call state machine, redaction | nothing (no LiveKit, DOM or React Native) |
| `@hainiva/agent-sdk/web` | `joinCallRoom` (LiveKit), `localStorageStore` (opt-in) | `livekit-client` |
| `@hainiva/agent-sdk/react-native` | `joinCallRoom`, `secureStoreSessionStore`, `<HainivaDesk/>` | `livekit-client`, `@livekit/react-native`, `expo-secure-store`; `react-native-webview` for `<HainivaDesk/>` |
| `@hainiva/agent-sdk/embed` | `mountDesk()`: the full HAINIVA desk inside your web page | a browser |

Native ringing on phones (CallKit / Android call notification) is
[`@hainiva/react-native-call`](https://github.com/hainiva/react-native-call).
Samples: [`examples/`](./examples) — a Node assertion signer, an Expo staff
app and a web softphone.

## Install

```sh
npm install @hainiva/agent-sdk livekit-client
```

## Quickstart

```ts
import { HainivaAgent } from "@hainiva/agent-sdk";
import { joinCallRoom } from "@hainiva/agent-sdk/web";

const agent = new HainivaAgent({
  baseUrl: "https://api.hainiva.com",
  tenantId: "YOUR_ORGANISATION_ID",
  // Ask YOUR backend for a fresh assertion — every time (see below).
  getAssertion: () => fetch("/my-backend/hainiva-assertion", { method: "POST", credentials: "include" })
    .then((r) => r.json()).then((j) => j.assertion),
  media: joinCallRoom,
});

agent.on("call.ringing", (r) => showRing(r.callId, r.contactName ?? r.callerNumber));
agent.on("calls", (state) => render(state));          // the call state machine
agent.on("wrapup.required", (w) => askForWrapUp(w.callId));
agent.on("revoked", () => showSignIn());               // HAINIVA ended the session

const me = await agent.connect();                      // sign in, me, socket, rings waiting
await agent.setStatus("online");

await agent.calls.accept(callId);                      // answers and joins the room
await agent.calls.hold(callId, true);
await agent.calls.transfer(callId, { kind: "queue", queueId, name: "Support" });
await agent.calls.end(callId);
await agent.wrapUp(callId, { dispositionCode: "resolved", notes: "…" });

await agent.disconnect({ signOut: true });
```

Everything else is on the same object: `conversations.list/get/assign/release/
transfer/close`, `messages.list/send/typing`, `dispositions()`,
`supervisor.liveCalls/agents/supervise/setMode`, `push.register/unregister`,
`rings.pending()`, `joinMedia(callId)` (re-join with a fresh LiveKit token).
`agent.rest` is the typed REST client for every `/agent/v1` endpoint, and the
response types (`AgentMeDto`, `AgentConversationDto`, …) are exported.

## Sign-in: your backend vouches for your staff member

Your backend holds the agent app's **private key** (HAINIVA stores only the
public key, or reads your `jwksUrl`). After it has authenticated the staff
member with **your own** login, it signs a short assertion:

| | |
| --- | --- |
| header | `alg: "ES256"` (or `RS256`), `kid`: the key id you registered. `HS256` works only for a test app on a sandbox organisation. |
| `iss` | your agent app id |
| `sub` | the member's `externalId` (`PUT /v1/members/by-external-id/:externalId`) |
| `aud` | `hainiva-agent` |
| `jti` | unique: each assertion works once |
| `iat` / `exp` | now / at most 5 minutes ahead |

Roles never come from the assertion — HAINIVA uses the role set on the member.
The SDK calls `getAssertion` every time it needs a new session and never caches
or stores the assertion. See [`examples/node-signer`](./examples/node-signer)
for key generation and a complete signer.

**Sessions.** An access token lasts 15 minutes and is refreshed before it
expires (one refresh however many requests are waiting; the refresh token
rotates). A request answered `401 token_expired` refreshes and is retried once.
A refused refresh (expired, revoked, reused) signs in again with a new
assertion. `401 session_revoked` (signed out elsewhere, sessions revoked,
member suspended, role changed, app paused) ends this session: the SDK forgets
it and emits `revoked`.

**Revoking sessions does not cut a member off.** The next `connect()`, or the
embedded desk asking for a token, signs in again with a fresh assertion, and
your backend still vouches for the member, so it succeeds. To stop someone
working, suspend or delete the member (`PATCH /v1/members/:id
{"status":"suspended"}`, `DELETE /v1/members/:id`) or pause the agent app; then
sign-in is refused (`401 session_refused`, `403 agent_app_paused`). Stop
signing assertions for them on your side too.

## Events

`agent.on(name, fn)` — from the event socket (only this member's events,
filtered by HAINIVA):

| Event | Data |
| --- | --- |
| `call.ringing` | `{callId, conversationId, path: direct\|queue\|transfer, channel, line, contactName, callerNumber, transferMode?, expiresAt}` |
| `call.ended` | `{callId \| null, conversationId, reason: ended\|failed\|answered_elsewhere\|declined\|expired\|transfer_ended}` |
| `conversation.assigned` | `{conversationId, callId, channel, contactName}` |
| `message.created` | `{conversationId, interactionId, channel, preview, contentType, senderName}` |
| `wrapup.required` | `{callId, conversationId, deadlineAt}` |
| `presence.changed` | `{callId, participantId, role, presence}` |
| `supervisor.alert` | the alert (supervisors) |
| `call.supervised` | `{callId, conversationId, supervisorId, supervisorName, mode}`: a supervisor joined this member's call or changed mode (`monitor`, `whisper`, `barge`) |
| `event.unknown` | an event name newer than this SDK |

And from the SDK itself: `connection` (socket state), `ready`, `calls` (the
call state), `callEffect` (stop a native ring, leave media — media is handled
for you), `resync` (events were missed beyond what HAINIVA keeps: rings are
refetched, refetch your own lists), `session.expiring`, `revoked`, `error`.

The socket authenticates in its **first frame** (the token is never in the
URL), resumes from the last event after a reconnect, sends a refreshed token
without reconnecting, and reconnects with backoff — except when HAINIVA revoked
the session or the member has too many sockets open.

## Calls

`agent.callsState` / the `calls` event is the HAINIVA Agent app's call state
machine: one call at a time, concurrent rings, ring expiry, decline, taken
elsewhere, caller hanging up while you answer, hold, mute, warm and blind
transfer. `CallStore` and the pure `transition(state, event)` are exported for
Redux, Zustand or tests.

## Push: rings with YOUR app's own credentials

Phones ring through **your** app with **your** Firebase / APNs credentials.

1. **Upload them** on the agent app — Organization → Developer → Agent apps →
   the bell, or `PUT /v1/agent-apps/:id/push-credentials` (key scope
   `agent_apps:write`):
   ```jsonc
   {
     "fcm":  { "serviceAccount": { /* the service-account key file */ }, "expiresAt": "2027-11-01T00:00:00Z" },
     "apns": { "keyP8": "<contents of AuthKey_XXXXXXXXXX.p8>", "keyId": "XXXXXXXXXX", "teamId": "YYYYYYYYYY",
               "topic": "com.example.agentapp", "environment": "production" }
   }
   ```
   HAINIVA checks each with Google / Apple before saving (a refusal names the
   problem: `fcm_auth_failed`, `apns_auth_failed`, `apns_topic_not_allowed`, …),
   stores it encrypted and never returns it — only a fingerprint, the status
   and the expiry you declare (your admins are alerted 14 days before, and at
   once if Google or Apple start refusing it). The APNs `topic` must be one of
   the agent app's `allowedBundleIds`. `null` removes a platform.
2. **Register each phone** after sign-in:
   ```ts
   await agent.push.register({ platform: "android", token: fcmToken, kind: "voip", bundleId: "com.example.agentapp", deviceId });
   await agent.push.register({ platform: "ios", token: pushKitToken, kind: "voip", bundleId: "com.example.agentapp", deviceId });
   ```
   A phone stops ringing when its sign-in ends; call `push.unregister(token)`
   before signing out anyway.
3. **Show the ring** with `@hainiva/react-native-call` — Android: the FCM data
   message `{type: "call", tenantId, interactionId, conversationId, path,
   caller, line, expiresAt, transferMode?}` (all strings; `expiresAt` in Unix
   milliseconds) and `{type: "call_cancel", tenantId, interactionId, reason}`;
   iPhone: a VoIP push to `<topic>.voip` with the same fields, reported to
   CallKit natively (ring ends come over the socket, not as a push). See
   [`examples/expo-agent-app`](./examples/expo-agent-app).

## Web

Add your page's exact origin to the agent app's `allowedOrigins`. HAINIVA
answers the browser's CORS preflight only for origins an agent app lists, and
checks every request against the origins of the app its session belongs to
(`403 origin_not_allowed`). A page on an origin that no app lists is refused at
the preflight, before any sign-in: `connect()` fails with a
`HainivaAgentError` of status `0` (`network_error`), which in the browser's
network panel is a CORS error.

The session is kept **in memory** by default: a reload signs in again with a
fresh assertion. `localStorageStore()` keeps it across reloads, but **any
script on your origin can read localStorage, refresh token included** — use it
only with a strict Content-Security-Policy and no third-party scripts.

## React Native

```ts
import * as SecureStore from "expo-secure-store";
import { joinCallRoom, secureStoreSessionStore } from "@hainiva/agent-sdk/react-native";
const agent = new HainivaAgent({ …, store: secureStoreSessionStore(SecureStore), media: joinCallRoom });
```

The session lives in the iOS Keychain (readable after first unlock, so a ring
that wakes a locked phone finds it; never migrated to another device) or the
Android Keystore. There is no fallback to a plain store. Call
`registerGlobals()` from `@livekit/react-native` once at startup.

## The embedded desk

Show the whole HAINIVA desk inside your product, signed in as your staff
member with **your** agent session — no HAINIVA login screen, no password.

```ts
import { mountDesk } from "@hainiva/agent-sdk/embed";

await agent.connect();
const desk = mountDesk(document.getElementById("desk")!, {
  agent,                                   // your connected HainivaAgent
  appId: "YOUR_AGENT_APP_ID",
  baseUrl: "https://app.hainiva.com",      // the HAINIVA desk
  theme: "light", locale: "vi",
  onEnded: (reason) => showSignedOut(reason),
});
desk.setTheme("dark");
desk.destroy();
```

- **Your page's origin must be in the agent app's `allowedOrigins`.** That list
  is also the desk's CSP `frame-ancestors`: any other site gets a blank frame
  (and `onEnded("load_failed")`). Adding an origin lets that site embed the desk
  for this app's staff — list only sites you control.
- The SDK exchanges your agent session for a 15-minute **desk token**
  (`POST /agent/v1/desk-session`, `agent.desk.session()`) and hands it to the
  desk over `postMessage` — never in the URL, never stored. The desk asks for a
  new one before it expires. When your session ends for good (sign-out,
  member suspended or deleted, app paused) the desk shows "ended" at once and
  `onEnded` fires. Revoking sessions alone does not end the desk: the SDK signs
  in again with a fresh assertion (see Sessions above).
- The desk token works only for the desk's own work (conversations, calls,
  contacts, tickets…). Settings, team, billing, developer and admin pages are
  refused, and it can never switch organisation.
- The iframe is created with
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"`
  (never top navigation: the desk cannot navigate your page) and
  `allow="microphone; camera; autoplay; clipboard-write"`. On the web **the desk
  carries calls itself (WebRTC)**; if your own iframe or Permissions-Policy does
  not delegate the microphone, or the person refuses it, `onMediaError(name)`
  tells you.
- Messages are read only from that iframe's window **and** the desk origin, and
  only in the documented shapes; everything is sent to the desk origin only.

React Native — calls stay native in your app (`@hainiva/react-native-call`),
the desk hands them to you:

```tsx
import { WebView } from "react-native-webview";
import { HainivaDesk } from "@hainiva/agent-sdk/react-native";

<HainivaDesk agent={agent} appId={APP_ID} baseUrl="https://app.hainiva.com" WebView={WebView}
  onDial={(number, contactId) => placeCall(number, contactId)}
  onDialer={(prefill) => openDialer(prefill)}
  onOpenUrl={(url) => Linking.openURL(url)}
  onEnded={(reason) => signOut(reason)} />
```

The WebView stays on the desk origin (`originWhitelist`, every other URL goes
to `onOpenUrl`), opens no windows, and gets its bridge before the desk's
scripts, on the desk origin only.

## Documentation

- [HAINIVA developer docs](https://hainiva.com/en/developers/docs) — start with
  [Quickstart: your own staff app](https://hainiva.com/en/developers/docs/quickstart-staff-app), then
  [Staff sign-in and agent apps](https://hainiva.com/en/developers/docs/staff-sign-in),
  [Agent API](https://hainiva.com/en/developers/docs/agent-api), [Events](https://hainiva.com/en/developers/docs/events),
  [Push setup](https://hainiva.com/en/developers/docs/push-setup) and [Embedded desk](https://hainiva.com/en/developers/docs/embedded-desk).
- [API reference](https://api.hainiva.com/docs/) — every endpoint, request and
  error code.
- [Troubleshooting](https://hainiva.com/en/developers/docs/troubleshooting).
- Sibling SDKs: [`@hainiva/react-native-call`](https://github.com/hainiva/react-native-call)
  (native ringing) and [`@hainiva/app-sdk`](https://github.com/hainiva/app-sdk)
  (your customers' app, the App channel).

## Security

- **No tokens in URLs or logs.** Tokens travel in the `Authorization` header or
  the socket's first frame; configured URLs are checked (TLS only, no
  `user:pass@`, no credential-like query parameter). Errors and the `log`
  callback are redacted (JWTs, Bearer values, token parameters, HAINIVA key
  prefixes and the exact tokens the SDK holds). The SDK never writes to the
  console.
- **Never put the private key in an app.** Only your backend signs assertions.
  Rotate keys with `POST /v1/agent-apps/:id/rotate-credential` (the old key
  keeps working 24 h; `immediate: true` when it leaked) and push credentials by
  uploading new ones.
- Every POST carries an `Idempotency-Key`, so a retry never acts twice.
- See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
