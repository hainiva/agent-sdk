# Assertion signer (Node)

Your backend proves to HAINIVA who your staff member is by signing a short
**assertion** (an ES256 JWT) with your agent app's **private key**. HAINIVA
holds only the public key, so a leak on HAINIVA's side can never be used to
sign your staff in.

## 1. Make a key pair (once, on a trusted machine)

```sh
# Private key: stays on your backend (a secret store or a file outside the repo, mode 600)
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out agent-app-private.pem
chmod 600 agent-app-private.pem
# Public key: this is what you give HAINIVA
openssl pkey -in agent-app-private.pem -pubout -out agent-app-public.pem
```

Never commit the private key, never put it in a mobile or web app, and never
paste it anywhere: HAINIVA refuses a private key and asks you to treat it as
leaked.

## 2. Register the agent app (Management API, key with `agent_apps:write`)

```sh
curl -X POST https://api.hainiva.com/v1/agent-apps \
  -H "Authorization: Bearer $HAINIVA_API_KEY" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile pem agent-app-public.pem '{
        name: "Acme staff app",
        credential: { kind: "public_keys", keys: [ { kid: "key-1", alg: "ES256", pem: $pem } ] },
        settings: { allowedBundleIds: ["com.example.agentapp"], allowedOrigins: ["https://agents.example.com"] }
      }')"
```

Keep the `id` it answers: it is `AGENT_APP_ID`. Members are created with
`PUT /v1/members/by-external-id/<your staff id>`.

**Rotating the key**: make a new pair with a new `kid`, then
`POST /v1/agent-apps/:id/rotate-credential` with the new public key. The old
key keeps working for 24 hours so you can roll out; add `"immediate": true` if
the old key leaked (every session of the app ends at once).

## 3. Run

```sh
npm install
AGENT_APP_ID=<id> AGENT_APP_KEY_ID=key-1 AGENT_APP_PRIVATE_KEY_FILE=/secure/agent-app-private.pem \
WEB_ORIGIN=https://agents.example.com DEMO_STAFF_TOKEN=change-me DEMO_STAFF_ID=staff-42 npm start
```

`authenticateStaff()` in `src/server.ts` is a demo: replace it with your own
login. The signer must decide who the staff member is from **your** session,
never from the request body.

## The assertion

| Claim | Value |
| --- | --- |
| header `alg` / `kid` | `ES256` (or `RS256`) / the kid you registered |
| `iss` | your agent app id |
| `sub` | the member's `externalId` |
| `aud` | `hainiva-agent` |
| `jti` | unique per assertion (single use) |
| `iat`, `exp` | now, and at most 5 minutes ahead |

Roles never come from the assertion: HAINIVA uses the role you set on the
member.

## A headless agent

`npm run agent` signs in with `@hainiva/agent-sdk` through this signer, goes
online and prints rings, call ends and messages (see `src/agent.ts`).
