/**
 * A sample staff app on @hainiva/agent-sdk + @hainiva/react-native-call:
 * sign in through your signer, set a status, ring (also when the app is
 * killed), answer with LiveKit, hold / hang up, wrap up.
 */
import { useEffect, useState } from "react";
import { Alert, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { activeCall, ringingCalls, type AgentStatus, type CallsState } from "@hainiva/agent-sdk";
import { agent, signOut, start } from "./src/hainiva";

const STATUSES: AgentStatus[] = ["online", "away", "busy", "offline"];

export default function App() {
  const [calls, setCalls] = useState<CallsState>(agent.callsState);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [name, setName] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const offs = [
      agent.on("calls", setCalls),
      agent.on("revoked", () => setError("Signed out by HAINIVA. Sign in again.")),
      agent.on("wrapup.required", (w) => {
        void agent.dispositions().then((codes) => {
          const first = codes[0];
          Alert.alert("Wrap-up", first ? `Mark as "${first.label}"?` : "Close this call?", [
            { text: "Later", style: "cancel" },
            { text: "OK", onPress: () => { void agent.wrapUp(w.callId, first ? { dispositionCode: first.code } : {}); } },
          ]);
        });
      }),
    ];
    start()
      .then(() => { setName(agent.me?.displayName ?? ""); setStatus(agent.me?.status ?? null); })
      .catch((e: Error) => setError(e.message));
    return () => { for (const off of offs) off(); };
  }, []);

  const live = activeCall(calls);
  const rings = ringingCalls(calls);
  const choose = (s: AgentStatus) => { void agent.setStatus(s).then(() => setStatus(s)).catch((e: Error) => setError(e.message)); };

  return (
    <SafeAreaView style={styles.page}>
      <Text style={styles.title}>{name || "Signing in…"}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.row}>
        {STATUSES.map((s) => (
          <Pressable key={s} onPress={() => choose(s)} style={[styles.chip, status === s && styles.chipOn]}>
            <Text style={styles.chipText}>{s}</Text>
          </Pressable>
        ))}
      </View>
      {rings.map((r) => (
        <View key={r.info.id} style={styles.card}>
          <Text style={styles.cardText}>{`${r.info.from || "Unknown"} — ${r.info.line ?? r.info.path}`}</Text>
          <View style={styles.row}>
            <Pressable style={styles.answer} onPress={() => { void agent.calls.accept(r.info.id).catch((e: Error) => setError(e.message)); }}><Text style={styles.chipText}>Answer</Text></Pressable>
            <Pressable style={styles.decline} onPress={() => { void agent.calls.decline(r.info.id); }}><Text style={styles.chipText}>Decline</Text></Pressable>
          </View>
        </View>
      ))}
      {live ? (
        <View style={styles.card}>
          <Text style={styles.cardText}>{`${live.phase}: ${live.info.from}`}</Text>
          <View style={styles.row}>
            <Pressable style={styles.chip} onPress={() => { void agent.calls.mute(live.info.id, !live.muted); }}><Text style={styles.chipText}>{live.muted ? "Unmute" : "Mute"}</Text></Pressable>
            <Pressable style={styles.chip} onPress={() => { void agent.calls.hold(live.info.id, live.phase !== "held"); }}><Text style={styles.chipText}>{live.phase === "held" ? "Resume" : "Hold"}</Text></Pressable>
            <Pressable style={styles.decline} onPress={() => { void agent.calls.end(live.info.id); }}><Text style={styles.chipText}>Hang up</Text></Pressable>
          </View>
        </View>
      ) : null}
      <Pressable style={styles.chip} onPress={() => { void signOut(); }}><Text style={styles.chipText}>Sign out</Text></Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 16, backgroundColor: "#0f172a" },
  title: { color: "white", fontSize: 20, fontWeight: "600", marginBottom: 12 },
  error: { color: "#fca5a5", marginBottom: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#334155" },
  chipOn: { backgroundColor: "#4f46e5" },
  chipText: { color: "white" },
  card: { padding: 12, borderRadius: 10, backgroundColor: "#1e293b", marginBottom: 12 },
  cardText: { color: "white", marginBottom: 8 },
  answer: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#059669" },
  decline: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#dc2626" },
});
