/**
 * The assertion signer: YOUR backend vouches for YOUR staff member.
 *
 *   POST /hainiva/assertion  → { "assertion": "<ES256 JWT>" }
 *
 * HAINIVA never sees your private key — only the public key you registered on
 * the agent app. This endpoint must:
 *   1. authenticate the caller with YOUR OWN login (session cookie, SSO, …):
 *      it decides who the staff member is — never the request body;
 *   2. sign a short-lived assertion for that staff member: iss = your agent app
 *      id, sub = the member's externalId, aud = "hainiva-agent", a fresh jti,
 *      exp at most 5 minutes ahead (2 here);
 *   3. answer it with Cache-Control: no-store, and never log it.
 *
 * Plain Node (no framework): node:http + node:crypto. Run: npm start.
 */
import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`${name} is required (see README)`);
  return v;
};

const AGENT_APP_ID = env("AGENT_APP_ID");                       // the id HAINIVA gave your agent app
const KEY_ID = env("AGENT_APP_KEY_ID", "key-1");                // the kid you registered with the public key
const PRIVATE_KEY: KeyObject = createPrivateKey(readFileSync(env("AGENT_APP_PRIVATE_KEY_FILE")));  // a file OUTSIDE the repo, mode 600
const PORT = Number(env("PORT", "8787"));
/** Your web app's origin (the softphone sample), for CORS. Exact; never "*". */
const WEB_ORIGIN = process.env["WEB_ORIGIN"] ?? "";

if (PRIVATE_KEY.asymmetricKeyType !== "ec" || PRIVATE_KEY.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
  throw new Error("AGENT_APP_PRIVATE_KEY_FILE must be an EC P-256 private key (ES256)");
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** ES256 JWT. ieee-p1363 = the raw r||s signature JOSE requires (not DER). */
export function signAssertion(staffExternalId: string, now = Math.floor(Date.now() / 1000)): string {
  const header = { alg: "ES256", typ: "JWT", kid: KEY_ID };
  const claims = { iss: AGENT_APP_ID, sub: staffExternalId, aud: "hainiva-agent", jti: randomUUID(), iat: now, exp: now + 120 };
  const data = `${b64url(header)}.${b64url(claims)}`;
  const sig = sign("sha256", Buffer.from(data), { key: PRIVATE_KEY, dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}

/**
 * REPLACE THIS with your own authentication. It must return the externalId of
 * the staff member YOUR system has signed in — the one you gave HAINIVA with
 * PUT /v1/members/by-external-id/:externalId — or null.
 * The demo accepts a fixed bearer from DEMO_STAFF_TOKEN for DEMO_STAFF_ID only.
 */
function authenticateStaff(req: IncomingMessage): string | null {
  const demoToken = process.env["DEMO_STAFF_TOKEN"];
  const demoStaff = process.env["DEMO_STAFF_ID"];
  if (!demoToken || !demoStaff) return null;
  return req.headers.authorization === `Bearer ${demoToken}` ? demoStaff : null;
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  if (WEB_ORIGIN && req.headers.origin === WEB_ORIGIN) {
    res.setHeader("access-control-allow-origin", WEB_ORIGIN);
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "POST");
    res.setHeader("vary", "origin");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST" || req.url !== "/hainiva/assertion") return send(res, 404, { error: "not_found" });
  const staff = authenticateStaff(req);
  if (!staff) return send(res, 401, { error: "sign_in_required" });
  // Log WHO asked, never the assertion.
  console.log(`assertion issued for ${staff}`);
  return send(res, 200, { assertion: signAssertion(staff) });
});

server.listen(PORT, () => console.log(`signer on http://localhost:${PORT}/hainiva/assertion`));
