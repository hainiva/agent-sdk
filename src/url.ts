import { HainivaAgentError } from "./errors.js";

export interface UrlRules {
  /** "http" for REST (https required), "ws" for sockets (wss required). */
  kind: "http" | "ws";
  /** Allow http:// / ws:// to localhost (local development only). Default false. */
  allowInsecureLocalhost?: boolean;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** Query parameter names that would carry a credential. */
const CREDENTIAL_PARAM = /token|assertion|secret|password|passw|key|auth|jwt|session|signature|ticket/i;

/**
 * A base / socket / media URL a partner configured, checked before use: TLS only,
 * no user:password@, and no credential in the query string. Tokens travel in
 * headers or in the socket's first frame — never in a URL, which ends up in
 * access logs, proxies and browser history.
 */
export function assertSafeUrl(raw: string, rules: UrlRules): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HainivaAgentError(0, "invalid_url", { kind: rules.kind }); }
  const secure = rules.kind === "http" ? "https:" : "wss:";
  const insecure = rules.kind === "http" ? "http:" : "ws:";
  const local = LOCAL.has(u.hostname);
  if (u.protocol !== secure && !(u.protocol === insecure && local && rules.allowInsecureLocalhost)) {
    throw new HainivaAgentError(0, "insecure_url", { expected: secure, got: u.protocol, host: u.host });
  }
  if (u.username || u.password) throw new HainivaAgentError(0, "credentials_in_url", { host: u.host });
  let param: string | null = null;
  u.searchParams.forEach((_v, name) => { if (!param && CREDENTIAL_PARAM.test(name)) param = name; });
  if (param) throw new HainivaAgentError(0, "credentials_in_url", { host: u.host, param });
  if (/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/.test(u.search + u.hash + u.pathname)) {
    throw new HainivaAgentError(0, "credentials_in_url", { host: u.host });
  }
  return u;
}
