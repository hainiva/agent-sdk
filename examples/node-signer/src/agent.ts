/**
 * A headless agent in Node with @hainiva/agent-sdk: sign in through the signer
 * above, go online, print rings and messages, wrap up after calls. Useful as a
 * bot, a load test or a smoke test of your setup.
 *
 *   HAINIVA_API=https://api.hainiva.com HAINIVA_TENANT_ID=<your organisation id> \
 *   SIGNER_URL=http://localhost:8787/hainiva/assertion DEMO_STAFF_TOKEN=… npm run agent
 */
import { HainivaAgent, type AgentEventFrame } from "@hainiva/agent-sdk";

const api = process.env["HAINIVA_API"] ?? "https://api.hainiva.com";
const tenantId = process.env["HAINIVA_TENANT_ID"] ?? "";
const signer = process.env["SIGNER_URL"] ?? "http://localhost:8787/hainiva/assertion";

const agent = new HainivaAgent({
  baseUrl: api,
  tenantId,
  // A NEW assertion every time: the SDK never caches one.
  getAssertion: async () => {
    const r = await fetch(signer, { method: "POST", headers: { authorization: `Bearer ${process.env["DEMO_STAFF_TOKEN"] ?? ""}` } });
    if (!r.ok) throw new Error(`signer answered ${r.status}`);
    return ((await r.json()) as { assertion: string }).assertion;
  },
  device: { label: "node-agent", platform: "other" },
  // Redacted by the SDK before it reaches this function.
  log: (event, detail) => console.debug("[sdk]", event, detail ?? ""),
});

agent.on("connection", (s) => console.log("socket:", s));
agent.on("call.ringing", (r) => console.log(`ring ${r.callId} from ${r.contactName ?? r.callerNumber ?? "?"} (${r.path})`));
agent.on("call.ended", (e) => console.log(`call ${e.callId ?? e.conversationId} ended: ${e.reason}`));
agent.on("message.created", (m) => console.log("message:", m["preview"]));
agent.on("wrapup.required", async (w) => {
  const codes = await agent.dispositions();
  await agent.wrapUp(w.callId, { ...(codes[0] ? { dispositionCode: codes[0].code } : {}), notes: "wrapped up by the node sample" });
});
agent.on("event.unknown", (f: AgentEventFrame) => console.log("newer event:", f.event));
agent.on("revoked", ({ reason }) => { console.log("session ended by HAINIVA:", reason); process.exit(1); });

const me = await agent.connect();
console.log(`signed in as ${me.displayName} (${me.role})`);
await agent.setStatus("online");

process.on("SIGINT", () => {
  void agent.setStatus("offline").catch(() => undefined)
    .then(() => agent.disconnect({ signOut: true }))
    .finally(() => process.exit(0));
});
