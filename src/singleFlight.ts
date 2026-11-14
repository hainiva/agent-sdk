/**
 * Calls `fn` at most once at a time: callers that arrive while it runs share its
 * result (or its error). The next call after it settles runs `fn` again.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    inFlight ??= (async () => {
      try { return await fn(); }
      finally { inFlight = null; }
    })();
    return inFlight;
  };
}

export interface RefreshedToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface TokenRefresherOptions {
  /** Fetch a new token. Called once however many callers wait for it. */
  refresh: () => Promise<RefreshedToken>;
  /** Refresh this long before expiry. Default 60 s. */
  skewMs?: number;
  now?: () => number;
}

export interface TokenRefresher {
  /** A token valid for at least `skewMs`, refreshing (once, shared) when needed. */
  get(): Promise<string>;
  /** Forget the current token (the server refused it): the next get() refreshes. */
  invalidate(): void;
  /** Whether a token is held that is still valid beyond the skew. */
  readonly valid: boolean;
}

/**
 * Single-flight token refresh with a pluggable refresh function. Ten requests that
 * find the token expired cause one refresh, not ten — which also keeps a
 * rotating refresh token from being spent twice (reuse detection would then
 * revoke the whole session family).
 */
export function createTokenRefresher(o: TokenRefresherOptions): TokenRefresher {
  const skew = o.skewMs ?? 60_000;
  const now = o.now ?? Date.now;
  let current: RefreshedToken | null = null;
  const run = singleFlight(async () => {
    const t = await o.refresh();
    if (!t || typeof t.token !== "string" || !t.token) throw new Error("refresh returned no token");
    current = t;
    return t.token;
  });
  return {
    get valid() { return current !== null && current.expiresAt - now() > skew; },
    async get() {
      if (current && current.expiresAt - now() > skew) return current.token;
      return run();
    },
    invalidate() { current = null; },
  };
}
