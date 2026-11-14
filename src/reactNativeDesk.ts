/**
 * `<HainivaDesk/>` — the HAINIVA desk inside your React Native app.
 *
 *   import { WebView } from "react-native-webview";
 *   import { HainivaDesk } from "@hainiva/agent-sdk/react-native";
 *
 *   <HainivaDesk agent={agent} appId={APP_ID} baseUrl="https://app.hainiva.com"
 *     onDial={(number, contactId) => placeNativeCall(number, contactId)}
 *     onEnded={(reason) => goToSignIn(reason)} />
 *
 * The split is the HAINIVA Agent app's: YOUR app rings and carries call audio
 * natively (@hainiva/react-native-call + this SDK's CallStore); the desk shows
 * the work and hands calls to you (`onDial`, `onDialer`).
 *
 * Security:
 *   - `originWhitelist` and `onShouldStartLoadWithRequest` keep the WebView on
 *     the HAINIVA desk origin; any other URL is refused there (and offered to
 *     `onOpenUrl`, if you pass one);
 *   - no window.open passthrough (`setSupportMultipleWindows={false}`,
 *     `javaScriptCanOpenWindowsAutomatically={false}`);
 *   - the bridge is installed before the desk's scripts and ONLY when the page
 *     is on the desk origin; the desk token goes in by injectJavaScript, never
 *     in the URL, and is not written to storage.
 */
import * as React from "react";
import { DeskHost, deskUrl, type DeskCallbacks, type DeskTokenSource, type HostToDesk } from "./embed.js";

/** The parts of react-native-webview's WebView this component uses. */
export interface WebViewLike {
  injectJavaScript(script: string): void;
}
type WebViewComponent = React.ComponentType<Record<string, unknown> & { ref?: React.Ref<WebViewLike> }>;

export interface HainivaDeskProps extends DeskCallbacks {
  agent: DeskTokenSource;
  appId: string;
  /** The HAINIVA desk, e.g. https://app.hainiva.com. */
  baseUrl: string;
  theme?: "light" | "dark";
  locale?: "vi" | "en";
  /** react-native-webview's WebView. Default: required from "react-native-webview". */
  WebView?: WebViewComponent;
  /** Passed to the WebView. */
  style?: unknown;
  /** Local development only (http://localhost desk). */
  allowInsecureLocalhost?: boolean;
}

/** Runs before the desk's scripts, on the desk origin only: the partner-rn bridge the desk looks for. */
export function deskBridgeScript(deskOrigin: string, appId: string): string {
  return `(function(){if(location.origin!==${JSON.stringify(deskOrigin)})return;`
    + `window.__HAINIVA_EMBED__={host:"partner-rn",appId:${JSON.stringify(appId.toLowerCase())},q:[],deliver:function(s){this.q.push(String(s));}};})();true;`;
}

/** A message to the desk, as a script: JSON twice (a string literal of the JSON), nothing interpolated raw. */
export function deliverScript(m: HostToDesk): string {
  return `window.__HAINIVA_EMBED__&&window.__HAINIVA_EMBED__.deliver(${JSON.stringify(JSON.stringify(m))});true;`;
}

declare const require: (m: string) => unknown;

function defaultWebView(): WebViewComponent {
  const mod = require("react-native-webview") as { WebView?: WebViewComponent; default?: WebViewComponent };
  const W = mod.WebView ?? mod.default;
  if (!W) throw new Error("@hainiva/agent-sdk: install react-native-webview (or pass the WebView prop) to use <HainivaDesk/>");
  return W;
}

export function HainivaDesk(props: HainivaDeskProps): React.ReactElement {
  const url = React.useMemo(
    () => deskUrl(props.baseUrl, props.appId, props.allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}),
    [props.baseUrl, props.appId, props.allowInsecureLocalhost],
  );
  const origin = url.origin;
  const web = React.useRef<WebViewLike | null>(null);
  const latest = React.useRef(props);
  latest.current = props;

  const host = React.useMemo(() => new DeskHost(props.appId, props.agent,
    (m) => web.current?.injectJavaScript(deliverScript(m)),
    {
      onDial: (n, c) => latest.current.onDial?.(n, c),
      onDialer: (p) => latest.current.onDialer?.(p),
      onEnded: (r) => latest.current.onEnded?.(r),
      onOpenUrl: (u) => latest.current.onOpenUrl?.(u),
      onMediaError: (n) => latest.current.onMediaError?.(n),
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [props.appId, props.agent, origin]);

  React.useEffect(() => { if (props.theme && host.isReady) host.setTheme(props.theme); }, [props.theme, host]);
  React.useEffect(() => { if (props.locale && host.isReady) host.setLocale(props.locale); }, [props.locale, host]);
  // Unmounted: the desk drops its token.
  React.useEffect(() => () => { if (!host.isEnded) web.current?.injectJavaScript(deliverScript({ v: 1, type: "hainiva:end" })); }, [host]);

  const W = props.WebView ?? defaultWebView();
  return React.createElement(W, {
    ref: web,
    source: { uri: url.href },
    style: props.style,
    originWhitelist: [origin],
    injectedJavaScriptBeforeContentLoaded: deskBridgeScript(origin, props.appId),
    onMessage: (e: { nativeEvent: { data: string; url?: string } }) => {
      // Only from the desk origin (a page elsewhere never gets the bridge, and is refused below anyway).
      const from = e.nativeEvent.url;
      if (typeof from === "string" && !from.startsWith(`${origin}/`)) return;
      const wasReady = host.isReady;
      host.receive(e.nativeEvent.data);
      if (!wasReady && host.isReady) {
        if (latest.current.theme) host.setTheme(latest.current.theme);
        if (latest.current.locale) host.setLocale(latest.current.locale);
      }
    },
    onShouldStartLoadWithRequest: (r: { url: string }) => {
      if (r.url === "about:blank" || r.url.startsWith(`${origin}/`) || r.url.startsWith("blob:") || r.url.startsWith("data:")) return true;
      latest.current.onOpenUrl?.(r.url);
      return false;
    },
    setSupportMultipleWindows: false,
    javaScriptCanOpenWindowsAutomatically: false,
    allowFileAccess: false,
    allowUniversalAccessFromFileURLs: false,
    mixedContentMode: "never",
    domStorageEnabled: true,
    sharedCookiesEnabled: false,
    thirdPartyCookiesEnabled: false,
    mediaPlaybackRequiresUserAction: false,
  });
}
