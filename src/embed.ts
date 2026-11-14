/**
 * @hainiva/agent-sdk/embed — the embeddable HAINIVA desk (iframe / WebView with a
 * postMessage bridge). Planned for milestone M3; not part of this release.
 */

export interface MountDeskOptions {
  container: unknown;
  getAccessToken: () => Promise<string>;
}

export interface MountedDesk {
  destroy(): void;
}

/** Not yet available: throws. */
export function mountDesk(_options?: MountDeskOptions): MountedDesk {
  throw new Error("@hainiva/agent-sdk/embed is not yet available");
}
