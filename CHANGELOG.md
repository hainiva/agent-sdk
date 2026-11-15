# Changelog

All notable changes to `@hainiva/agent-sdk` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[Semantic Versioning](https://semver.org/). While the version is `0.x`, a minor
release (`0.2.0`) may change the API; a patch release (`0.1.1`) never does.

## [Unreleased]

## [0.3.2] - 2026-11-15

- New event `call.supervised` `{callId, conversationId, supervisorId,
  supervisorName, mode}`: a supervisor joined this member's call, or changed
  mode (`monitor`, `whisper`, `barge`). Show it to the member, as the HAINIVA
  desk does. 0.3.1 and older deliver it as `event.unknown`.

## [0.3.1] - 2026-11-15

- README: the product is named HAINIVA; new Documentation section linking the
  developer docs, the API reference and the sibling SDKs. No code changes.

## [0.3.0] - 2026-11-14

- `@hainiva/agent-sdk/embed`: `mountDesk(container, { agent, appId, baseUrl,
  theme?, locale?, onEnded?, onDial?, onDialer?, onOpenUrl?, onMediaError? })`
  shows the HAINIVA desk in a sandboxed iframe signed in with your agent
  session and returns `{ destroy(), setTheme(), setLocale(), iframe }`. The
  handshake checks `event.source` and the desk origin, posts to the desk origin
  only, supplies and refreshes the desk token (single flight), and ends on a
  refused session or when the desk does not load (`load_failed`). Exports the
  protocol (`DeskToHost`, `HostToDesk`, `parseDeskMessage`), `DESK_SANDBOX`,
  `DESK_ALLOW` and `deskUrl()`.
- `@hainiva/agent-sdk/react-native`: `<HainivaDesk agent appId baseUrl onDial …/>`
  in a `react-native-webview` WebView (optional peer, or pass `WebView`):
  bridge injected before the desk's scripts on the desk origin only,
  `originWhitelist` limited to the desk, no `window.open` passthrough; calls
  are handed to your app (`onDial`, `onDialer`).
- `agent.desk.session()` / `AgentRestClient.deskSession()`:
  `POST /agent/v1/desk-session` → `AgentDeskSessionDto {token, expiresAt}`.
- Optional peers `react` and `react-native-webview` (only for `<HainivaDesk/>`).

## [0.2.0] - 2026-11-14

- `HainivaAgent`: one object for a staff member's app — `connect()`, `me`,
  `setStatus`, `rings.pending`, `calls.accept/decline/end/hold/mute/transfer`,
  `joinMedia` (through the `/web` or `/react-native` LiveKit adapter),
  `conversations.*`, `messages.*`, `wrapUp`, `dispositions`, `supervisor.*`,
  `push.register/unregister`, `on(event)`, `disconnect({ signOut })`.
- `AgentRestClient`: every `/agent/v1` endpoint, typed with the Agent API
  contract (`AgentMeDto`, `AgentAcceptDto`, …, exported). Errors are
  `HainivaAgentError` from the `{error:{code,message}}` envelope. A 401
  `token_expired` refreshes once (single flight) and retries; a refused refresh
  signs in again with a new assertion; `session_revoked` is final. Every POST
  carries an `Idempotency-Key` (reused by the retry). Timeouts and
  `AbortSignal`. Ids are checked before they go into a path.
- `/agent/v1/ws` bindings (`agentSocketBindings`): auth first frame with the
  resume position, `token.refresh`, `session.expiring` (refresh at once),
  `resync_required` (rings refetched, `resync` event), close codes 4001 / 4003
  / 4009. `call.*` events drive the `CallStore`.
- `SessionManager.invalidate(refusedToken)` ignores a refusal of an older token;
  `SessionManager.clear()` forgets a session the server already ended.
- `ReconnectingSocket` `closeCodes.fatal`: close codes that stop reconnecting.

## [0.1.0]

Not published to npm; its contents shipped in 0.2.0.

- `SessionManager`: sign-in with a fresh assertion from your backend every
  time, pluggable `SessionStore` (memory by default), single-flight refresh
  before expiry, new sign-in when a refresh is refused.
- `ReconnectingSocket`: first-frame auth, exponential backoff with jitter,
  heartbeat with dead-connection timeout, `resume {lastSeq}` hook, duplicate
  frame suppression, revoked / token-expired close codes, pluggable frames.
- `CallStore` / `transition`: the agent call state machine (ringing,
  connecting, active, held, transferring, ended; concurrent rings; ring expiry).
- `TypedEmitter`, `singleFlight`, `createTokenRefresher`, `assertSafeUrl`,
  `Redactor`, `HainivaAgentError` (redacted).
- `/web`: `localStorageStore` (opt-in), `joinCallRoom` (LiveKit).
- `/react-native`: `secureStoreSessionStore`, `joinCallRoom` (LiveKit).
- `/embed`: placeholder, throws.

[Unreleased]: https://github.com/hainiva/agent-sdk/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/hainiva/agent-sdk/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/hainiva/agent-sdk/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/hainiva/agent-sdk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hainiva/agent-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hainiva/agent-sdk/releases/tag/v0.1.0
