# Web embed sample

The whole HAINIVA desk inside your own web page, signed in as your staff member
with your agent session — no HAINIVA login screen.

1. Add the page's exact origin (e.g. `https://agents.example.com`) to the agent
   app's `allowedOrigins`. **That list is also the desk's CSP
   `frame-ancestors`**: it decides which sites may frame the desk for this
   app's staff. A site that is not listed gets a blank frame (and the SDK calls
   `onEnded("load_failed")`). List only sites you control.
2. Set `tenantId`, `agentAppId` and `signer` in `src/main.ts`.
3. `npm install && npm run dev`.

What happens: `agent.connect()` signs in through your signer; `mountDesk()`
creates a sandboxed iframe at `https://app.hainiva.com/embed?app=<agentAppId>`
(the URL never carries a token), answers the desk's `hainiva:ready` with a
15-minute desk token from `POST /agent/v1/desk-session` over `postMessage`
(to the desk origin only), and refreshes it when the desk asks. Signing out,
or the member being suspended or deleted, or the app paused, ends the desk
immediately. **Revoking the member's sessions does not**: the SDK signs in again
through your signer, which still vouches for the member, and the desk carries
on. To cut someone off, suspend or delete the member, or pause the app.

If the page's origin is not in any agent app's `allowedOrigins`, the browser's
CORS preflight is refused before sign-in: `agent.connect()` fails with a
`HainivaAgentError` of status `0` (`network_error`).

Calls: in a browser the desk carries call audio itself (WebRTC). The iframe is
created with `allow="microphone; camera; autoplay; clipboard-write"`; if your
own page is framed or sends a `Permissions-Policy`, it must delegate the
microphone too. A refused microphone reaches `onMediaError`.

For local development against a **sandbox** organisation, a test agent app may
list `http://localhost:<port>`; live apps accept exact `https://` origins only.
