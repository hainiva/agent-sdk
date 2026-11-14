import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJ2aWRlbyI6e319.lksig";

const state = vi.hoisted(() => ({ fail: null as Error | null, rooms: [] as any[] }));

vi.mock("livekit-client", () => {
  class Room {
    handlers = new Map<string, Set<() => void>>();
    connected: [string, string, unknown] | null = null;
    disconnected = 0;
    mic: boolean[] = [];
    localParticipant = { setMicrophoneEnabled: async (on: boolean) => { this.mic.push(on); } };
    constructor() { state.rooms.push(this); }
    async connect(url: string, token: string, o: unknown) { if (state.fail) throw state.fail; this.connected = [url, token, o]; }
    async disconnect() { this.disconnected++; }
    on(ev: string, fn: () => void) { if (!this.handlers.has(ev)) this.handlers.set(ev, new Set()); this.handlers.get(ev)!.add(fn); return this; }
    off(ev: string, fn: () => void) { this.handlers.get(ev)?.delete(fn); return this; }
    fire(ev: string) { for (const f of this.handlers.get(ev) ?? []) f(); }
  }
  return { Room, RoomEvent: { Disconnected: "disconnected" } };
});

import { joinCallRoom } from "./livekit.js";
import * as web from "./web.js";
import * as rn from "./react-native.js";

beforeEach(() => { state.fail = null; state.rooms = []; });

describe("joinCallRoom (web + react-native)", () => {
  it("is exported from both adapters", () => {
    expect(web.joinCallRoom).toBe(joinCallRoom);
    expect(rn.joinCallRoom).toBe(joinCallRoom);
  });

  it("connects with the token, turns the mic on, mutes, reports disconnect, leaves once", async () => {
    const call = await joinCallRoom({ url: "wss://livekit.hainiva.com", token: TOKEN });
    const room = state.rooms[0];
    expect(room.connected[0]).toBe("wss://livekit.hainiva.com");
    expect(room.connected[1]).toBe(TOKEN);
    expect(room.mic).toEqual([true]);
    await call.setMuted(true);
    expect(room.mic).toEqual([true, false]);
    const ended = vi.fn();
    const off = call.onDisconnected(ended);
    room.fire("disconnected");
    off();
    room.fire("disconnected");
    expect(ended).toHaveBeenCalledTimes(1);
    await call.leave();
    await call.leave();
    expect(room.disconnected).toBe(1);
  });

  it("refuses an insecure or credential-carrying media URL before connecting", async () => {
    await expect(joinCallRoom({ url: "ws://livekit.hainiva.com", token: TOKEN })).rejects.toThrow(/insecure_url/);
    await expect(joinCallRoom({ url: `wss://livekit.hainiva.com/?access_token=${TOKEN}`, token: TOKEN })).rejects.toThrow(/credentials_in_url/);
    expect(state.rooms.length).toBe(0);
  });

  it("a failed connect is redacted (LiveKit errors can carry the signalling URL with the token)", async () => {
    state.fail = new Error(`could not establish signal connection: wss://livekit.hainiva.com/rtc?access_token=${TOKEN}&auto_subscribe=1`);
    const e = await joinCallRoom({ url: "wss://livekit.hainiva.com", token: TOKEN }).catch((x) => x);
    expect(e.code).toBe("media_connect_failed");
    expect(JSON.stringify(e.body) + e.message).not.toContain(TOKEN);
    expect(state.rooms[0].disconnected).toBe(1);
  });

  it("an opaque (non-JWT) media token is redacted too", async () => {
    state.fail = new Error("rejected token opaque-media-token-xyz");
    const e = await joinCallRoom({ url: "wss://livekit.hainiva.com", token: "opaque-media-token-xyz" }).catch((x) => x);
    expect(JSON.stringify(e.body)).not.toContain("opaque-media-token-xyz");
  });

  it("can join with the microphone off", async () => {
    await joinCallRoom({ url: "wss://livekit.hainiva.com", token: TOKEN }, { microphone: false });
    expect(state.rooms[0].mic).toEqual([]);
  });
});
