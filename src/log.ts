import { Redactor } from "./redact.js";

/** The partner's logger. The SDK logs nothing unless one is given. */
export type Logger = (event: string, detail?: unknown) => void;

/** A logger that redacts every detail before the partner's logger sees it. */
export function safeLogger(log: Logger | undefined, redactor: Redactor = new Redactor()): Logger {
  if (!log) return () => {};
  return (event, detail) => {
    try {
      log(redactor.string(event), detail === undefined ? undefined : redactor.value(detail));
    } catch { /* a broken logger must not break a call */ }
  };
}
