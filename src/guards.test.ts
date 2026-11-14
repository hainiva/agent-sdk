import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** Every module reachable from an entry, following relative imports (type-only imports included). */
function reachable(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const code = readFileSync(join(SRC, entry), "utf8");
  for (const m of code.matchAll(/from\s+["'](\.\/[^"']+)\.js["']/g)) reachable(`${m[1]!.slice(2)}.ts`, seen);
  return seen;
}
const imports = (file: string) => [...readFileSync(join(SRC, file), "utf8").matchAll(/from\s+["']([^"'.][^"']*)["']/g)].map((m) => m[1]);

describe("package guards", () => {
  it("the core entry never reaches livekit-client, react-native or the DOM adapters", () => {
    const core = reachable("index.ts");
    for (const f of core) {
      expect(imports(f), f).not.toContain("livekit-client");
      expect(imports(f).some((i) => /react-native|expo/.test(i!)), f).toBe(false);
    }
    expect(core.has("livekit.ts")).toBe(false);
    expect(core.has("web.ts")).toBe(false);
    expect(core.has("react-native.ts")).toBe(false);
  });

  it("only the web / react-native adapters import livekit-client", () => {
    const users = sources.filter((f) => imports(f).includes("livekit-client"));
    expect(users).toEqual(["livekit.ts"]);
    expect(reachable("web.ts").has("livekit.ts")).toBe(true);
    expect(reachable("react-native.ts").has("livekit.ts")).toBe(true);
  });

  it("the SDK itself never writes to the console", () => {
    for (const f of sources) expect(readFileSync(join(SRC, f), "utf8"), f).not.toMatch(/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/);
  });

  it("no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependenciesMeta["livekit-client"].optional).toBe(true);
  });
});
