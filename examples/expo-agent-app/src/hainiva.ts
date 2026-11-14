/**
 * The HAINIVA side of the sample app: one HainivaAgent for the app's life,
 * the session in the Keychain / Android Keystore, rings through YOUR app's push
 * credentials (uploaded on the agent app: PUT /v1/agent-apps/:id/push-credentials).
 *
 * Ring flow
 *   Android: an FCM data push {type: "call", interactionId, caller, line, expiresAt}
 *            → showIncomingCall (the system call screen, also over the lock screen);
 *            {type: "call_cancel"} → cancelIncomingCall.
 *   iPhone:  a PushKit VoIP push is reported to CallKit natively before JS runs;
 *            the app learns of it with onCallPush. Ring ends arrive on the socket.
 *   Both:    "answer" on the native screen → agent.calls.accept → LiveKit.
 */
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import messaging from "@react-native-firebase/messaging";
import { registerGlobals } from "@livekit/react-native";
import {
  HainivaCall, getVoipToken, onCallAction, onCallPush, onVoipToken, setRingTenant, type CallAction,
} from "@hainiva/react-native-call";
import { HainivaAgent } from "@hainiva/agent-sdk";
import { joinCallRoom, secureStoreSessionStore } from "@hainiva/agent-sdk/react-native";

export const config = {
  api: "https://api.hainiva.com",
  tenantId: "YOUR_ORGANISATION_ID",
  /** Placeholder: your own bundle id / application id, also listed in the agent app's allowedBundleIds. */
  bundleId: "com.example.agentapp",
  /** Your backend's signer (examples/agent-sdk/node-signer). */
  signer: "https://agents.example.com/hainiva/assertion",
};

registerGlobals();

/** Your own app login, e.g. the token your backend issued at sign-in. Replace. */
async function myLoginToken(): Promise<string> {
  return (await SecureStore.getItemAsync("my-app-login")) ?? "";
}

export const agent = new HainivaAgent({
  baseUrl: config.api,
  tenantId: config.tenantId,
  getAssertion: async () => {
    const r = await fetch(config.signer, { method: "POST", headers: { authorization: `Bearer ${await myLoginToken()}` } });
    if (!r.ok) throw new Error(`signer answered ${r.status}`);
    return ((await r.json()) as { assertion: string }).assertion;
  },
  // Keychain (readable after first unlock: a ring that wakes a locked phone finds it) / Android Keystore.
  store: secureStoreSessionStore(SecureStore),
  media: joinCallRoom,
  device: { label: `${Platform.OS} sample`, platform: Platform.OS === "ios" ? "ios" : "android" },
});

// The native ring follows the call state: stop it when the call is taken elsewhere or the caller hangs up.
agent.on("callEffect", (e) => {
  if (e.type === "ring.cancel") HainivaCall?.cancelIncomingCall(e.id);
  if (e.type === "ended") { HainivaCall?.stopCallService(); HainivaCall?.setShowWhenLocked(false); }
});

/** A ring push's data (Android data message, or the iPhone VoIP payload). */
function onRingPush(data: Record<string, string | undefined>): void {
  const id = data["interactionId"];
  if (!id || data["tenantId"] !== config.tenantId) return;
  if (data["type"] === "call") HainivaCall?.showIncomingCall(id, data["caller"] ?? "", data["line"] ?? "", Number(data["expiresAt"] ?? 0));
  if (data["type"] === "call_cancel") HainivaCall?.cancelIncomingCall(id);
}

// Android: a killed app still runs this (registered at module load, before any UI).
messaging().setBackgroundMessageHandler(async (m) => { onRingPush(m.data ?? {}); });

async function handleAction(a: CallAction): Promise<void> {
  if (a.action === "answer") {
    try {
      await agent.connect().catch(() => agent.me); // cold start: restore the session first
      await agent.calls.accept(a.id);
      HainivaCall?.startCallService("HAINIVA");
      HainivaCall?.setShowWhenLocked(true);
    } catch {
      HainivaCall?.stopCallService();
    }
  }
  if (a.action === "decline") void agent.calls.decline(a.id).catch(() => undefined);
  if (a.action === "end") void agent.calls.end(a.id).catch(() => undefined);
}

let registeredToken: string | null = null;

/** Register this phone for rings with YOUR app's credentials. */
async function registerPush(): Promise<void> {
  const deviceId = (await SecureStore.getItemAsync("device-id")) ?? await (async () => {
    const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    await SecureStore.setItemAsync("device-id", id);
    return id;
  })();
  const register = async (token: string, platform: "ios" | "android") => {
    const sub = await agent.push.register({ platform, token, kind: "voip", bundleId: config.bundleId, deviceId });
    registeredToken = token;
    if (!sub.deliverable) console.warn("Push credentials for this platform are missing or refused on the agent app");
  };
  if (Platform.OS === "android") {
    await messaging().requestPermission();
    await register(await messaging().getToken(), "android");
    messaging().onTokenRefresh((t) => { void register(t, "android"); });
    messaging().onMessage(async (m) => { onRingPush(m.data ?? {}); });
  } else {
    const t = getVoipToken();
    if (t) await register(t, "ios");
    onVoipToken((x) => { void register(x, "ios"); });
    onCallPush((data) => onRingPush(data));
  }
}

/** Sign in, ring for this organisation, register push, and pick up an answer made before JS ran. */
export async function start(): Promise<void> {
  await agent.connect();
  setRingTenant(config.tenantId);
  await registerPush();
  onCallAction((a) => { void handleAction(a); });
  const pending = HainivaCall?.takePendingAction();
  if (pending) await handleAction(pending);
}

/** Sign out: stop ringing on this phone FIRST, then end the session. */
export async function signOut(): Promise<void> {
  if (registeredToken) await agent.push.unregister(registeredToken).catch(() => undefined);
  setRingTenant(null);
  await agent.setStatus("offline").catch(() => undefined);
  await agent.disconnect({ signOut: true });
}
