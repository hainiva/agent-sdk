import { Redactor, redactString, redactValue } from "./redact.js";

/**
 * Every error the SDK raises. The message is only `status code`, and the body is
 * redacted when the error is made: a partner who logs errors (or sends them to a
 * crash reporter) never ships a token with them.
 */
export class HainivaAgentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;

  /** status 0 = raised by the SDK itself (configuration, network), not by HAINIVA. */
  constructor(status: number, code: string, body: Record<string, unknown> = {}, redactor?: Redactor) {
    const c = redactor ? redactor.string(code) : redactString(code);
    super(`${status} ${c}`);
    this.name = "HainivaAgentError";
    this.status = status;
    this.code = c;
    this.body = (redactor ? redactor.value(body) : redactValue(body)) as Record<string, unknown>;
  }

  /** Wrap anything thrown below the SDK (fetch, WebSocket, LiveKit) without carrying its secrets along. */
  static from(e: unknown, code = "failed", redactor?: Redactor): HainivaAgentError {
    if (e instanceof HainivaAgentError) return e;
    const message = e instanceof Error ? e.message : String(e);
    return new HainivaAgentError(0, code, { cause: message }, redactor);
  }
}
