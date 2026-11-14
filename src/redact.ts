/**
 * Redaction: no token, assertion or secret may leave the SDK in an error message,
 * a log line or an event. Two layers:
 *  - patterns that catch credentials by shape (JWTs, Bearer headers, token query
 *    parameters, HAINIVA key prefixes), always on;
 *  - a Redactor that also knows the exact secrets this client holds right now
 *    (the current access and refresh tokens), so even an opaque token is caught.
 */

const PATTERNS: [RegExp, string][] = [
  // JWT / JWS / JWE (assertions, access tokens, LiveKit tokens).
  [/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){1,3}/g, "[redacted-jwt]"],
  // Authorization header values.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  // Credentials in a query string.
  [/([?&#](?:access_token|refresh_token|id_token|token|assertion|ticket|api_key|apikey|key|secret|signature|sig|password)=)[^&#\s"']+/gi, "$1[redacted]"],
  // HAINIVA API keys and refresh tokens by prefix.
  [/\b(aicc_(?:live|test)_|hnv_|agr_|apr_)[A-Za-z0-9_-]{6,}/g, "$1[redacted]"],
];

/** Object keys whose values are never shown. */
const SENSITIVE_KEY = /token|assertion|secret|password|passwd|authori[sz]ation|cookie|refresh|jwt|signature|api[-_]?key|private[-_]?key|credential/i;

/** Redact credential-shaped substrings. */
export function redactString(s: string, known: Iterable<string> = []): string {
  let out = s;
  for (const k of known) if (k && k.length >= 8) out = out.split(k).join("[redacted]");
  for (const [re, by] of PATTERNS) out = out.replace(re, by);
  return out;
}

/** A deep copy with credentials removed: sensitive keys blanked, strings scrubbed, Errors flattened. */
export function redactValue(v: unknown, known: Iterable<string> = [], depth = 0): unknown {
  const list = [...known];
  if (typeof v === "string") return redactString(v, list);
  if (v === null || typeof v !== "object") return v;
  if (depth > 6) return "[truncated]";
  if (v instanceof Error) {
    return { name: v.name, message: redactString(v.message, list), ...(v.stack ? { stack: redactString(v.stack, list) } : {}) };
  }
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => redactValue(x, list, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) && x !== null && x !== undefined && x !== "" ? "[redacted]" : redactValue(x, list, depth + 1);
  }
  return out;
}

/** Knows the secrets one client holds right now, on top of the patterns. */
export class Redactor {
  private readonly secrets = new Set<string>();
  add(...secrets: (string | null | undefined)[]): void { for (const s of secrets) if (s) this.secrets.add(s); }
  remove(...secrets: (string | null | undefined)[]): void { for (const s of secrets) if (s) this.secrets.delete(s); }
  clear(): void { this.secrets.clear(); }
  string(s: string): string { return redactString(s, this.secrets); }
  value(v: unknown): unknown { return redactValue(v, this.secrets); }
}
