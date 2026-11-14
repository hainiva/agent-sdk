# Web softphone sample

A single page: sign in through your signer (your login cookie authenticates
the request), set a status, see rings, answer with LiveKit, hold, hang up,
wrap up.

1. Add the page's exact origin (e.g. `https://agents.example.com`) to the agent
   app's `allowedOrigins`. HAINIVA answers the browser's CORS preflight only for
   origins an agent app lists, and every request is checked against the origins
   of the app its session belongs to. An origin that is not listed fails at the
   preflight, before sign-in: `connect()` rejects with a `HainivaAgentError` of
   status `0` (`network_error`), shown as a CORS error in the browser.
2. Set `tenantId` and `signer` in `src/main.ts`.
3. `npm install && npm run dev`.

The session stays in memory: a reload signs in again with a fresh assertion.
Keep the strict Content-Security-Policy in `index.html` (no third-party
scripts) on any page that holds a staff session.
