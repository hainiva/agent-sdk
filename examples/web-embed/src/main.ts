/**
 * The HAINIVA desk inside your web product (@hainiva/agent-sdk/embed).
 *
 * Your staff member is signed in with YOUR agent session (your signer, your
 * login) — no HAINIVA login screen. This page's exact origin must be in the
 * agent app's allowedOrigins: that list is also who may frame the desk.
 */
import { HainivaAgent } from "@hainiva/agent-sdk";
import { mountDesk, type MountedDesk } from "@hainiva/agent-sdk/embed";

const config = {
  api: "https://api.hainiva.com",
  desk: "https://app.hainiva.com",
  tenantId: "YOUR_ORGANISATION_ID",
  agentAppId: "00000000-0000-4000-8000-000000000000", // your agent app id
  /** Your backend's signer (examples/agent-sdk/node-signer); your login cookie authenticates the request. */
  signer: "https://agents.example.com/hainiva/assertion",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (s: string) => { $("status-line").textContent = s; };

const agent = new HainivaAgent({
  baseUrl: config.api,
  tenantId: config.tenantId,
  getAssertion: async () => {
    const r = await fetch(config.signer, { method: "POST", credentials: "include" });
    if (!r.ok) throw new Error(`signer answered ${r.status}`);
    return ((await r.json()) as { assertion: string }).assertion;
  },
  device: { label: navigator.userAgent.slice(0, 60), platform: "web" },
});

let desk: MountedDesk | null = null;

async function open(): Promise<void> {
  await agent.connect();
  desk = mountDesk($("desk"), {
    agent,
    appId: config.agentAppId,
    baseUrl: config.desk,
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    locale: "vi",
    onEnded: (reason) => { show(`The desk session ended (${reason}). Sign in again to continue.`); desk?.destroy(); desk = null; },
    onMediaError: (name) => show(`Microphone unavailable (${name}): allow it for this site.`),
  });
  show("");
}

$("signout").onclick = () => {
  desk?.destroy(); desk = null;
  void agent.disconnect({ signOut: true }).then(() => show("Signed out."));
};
$("theme").onchange = (e) => desk?.setTheme((e.target as HTMLSelectElement).value as "light" | "dark");

open().catch((e: Error) => show(e.message));
