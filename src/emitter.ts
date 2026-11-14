type Listener = (payload: unknown) => void;

/**
 * A small typed event emitter. `Events` maps each event name to its payload:
 *
 *   const e = new TypedEmitter<{ state: ConnectionState; ready: undefined }>();
 *   const off = e.on("state", (s) => …);   e.emit("state", "open");   e.emit("ready", undefined);
 *
 * A listener that throws does not stop the others; the error goes to `onError`.
 */
export class TypedEmitter<Events extends { [K in keyof Events]: unknown }> {
  private readonly listeners = new Map<keyof Events, Set<Listener>>();

  constructor(private readonly onError?: (error: unknown, event: keyof Events) => void) {}

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn as Listener);
    return () => this.off(event, fn);
  }

  once<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    const off = this.on(event, (p) => { off(); fn(p); });
    return off;
  }

  /** Remove a listener added with on(). (A once() listener is removed by the function once() returned.) */
  off<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): void {
    this.listeners.get(event)?.delete(fn as Listener);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (e) { this.onError?.(e, event); }
    }
  }

  listenerCount(event: keyof Events): number { return this.listeners.get(event)?.size ?? 0; }

  removeAll(): void { this.listeners.clear(); }
}
