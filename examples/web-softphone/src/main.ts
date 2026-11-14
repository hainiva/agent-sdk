/**
 * A minimal browser softphone on @hainiva/agent-sdk: sign in through your
 * signer, set a status, see rings, answer with LiveKit, hang up, wrap up.
 *
 * Your page's origin must be in the agent app's allowedOrigins (exact https
 * origin). Session in memory: a reload signs in again with a fresh assertion.
 */
import { HainivaAgent, activeCall, ringingCalls, type AgentStatus, type CallsState } from "@hainiva/agent-sdk";
import { joinCallRoom } from "@hainiva/agent-sdk/web";

const config = {
  api: "https://api.hainiva.com",
  tenantId: "YOUR_ORGANISATION_ID",
  /** Your backend's signer (examples/agent-sdk/node-signer); your login cookie authenticates the request. */
  signer: "https://agents.example.com/hainiva/assertion",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const agent = new HainivaAgent({
  baseUrl: config.api,
  tenantId: config.tenantId,
  getAssertion: async () => {
    const r = await fetch(config.signer, { method: "POST", credentials: "include" });
    if (!r.ok) throw new Error(`signer answered ${r.status}`);
    return ((await r.json()) as { assertion: string }).assertion;
  },
  media: joinCallRoom,
  device: { label: navigator.userAgent.slice(0, 60), platform: "web" },
});

function render(s: CallsState): void {
  const live = activeCall(s);
  const rings = ringingCalls(s);
  $("rings").replaceChildren(...rings.map((c) => {
    const li = document.createElement("li");
    li.textContent = `${c.info.from || "Unknown"} — ${c.info.line ?? c.info.path} `;
    const answer = document.createElement("button");
    answer.textContent = "Answer";
    answer.onclick = () => { void agent.calls.accept(c.info.id).catch((e: Error) => show(e.message)); };
    const decline = document.createElement("button");
    decline.textContent = "Decline";
    decline.onclick = () => { void agent.calls.decline(c.info.id).catch((e: Error) => show(e.message)); };
    li.append(answer, decline);
    return li;
  }));
  $("call").textContent = live ? `${live.phase}: ${live.info.from}${live.muted ? " (muted)" : ""}` : "No call";
  $<HTMLButtonElement>("hangup").disabled = !live;
  $<HTMLButtonElement>("hold").disabled = !live || (live.phase !== "active" && live.phase !== "held");
  $<HTMLButtonElement>("hold").textContent = live?.phase === "held" ? "Resume" : "Hold";
}

function show(text: string): void { $("status-line").textContent = text; }

agent.on("calls", render);
agent.on("connection", (s) => show(`Connection: ${s}`));
agent.on("revoked", () => show("Signed out by HAINIVA: reload to sign in again"));
agent.on("wrapup.required", (w) => {
  const notes = prompt("Wrap-up notes for this call?") ?? "";
  void agent.wrapUp(w.callId, { notes });
});

$("hangup").onclick = () => {
  const c = activeCall(agent.callsState);
  if (c) void agent.calls.end(c.info.id);
};
$("hold").onclick = () => {
  const c = activeCall(agent.callsState);
  if (c) void agent.calls.hold(c.info.id, c.phase !== "held");
};
$<HTMLSelectElement>("status").onchange = (e) => {
  void agent.setStatus((e.target as HTMLSelectElement).value as AgentStatus);
};
$("signout").onclick = () => { void agent.disconnect({ signOut: true }).then(() => show("Signed out")); };

agent.connect()
  .then((me) => { $("me").textContent = `${me.displayName ?? me.externalId} (${me.role})`; return agent.setStatus("online"); })
  .catch((e: Error) => show(`Sign-in failed: ${e.message}`));
