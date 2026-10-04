import fs from "node:fs";
import path from "node:path";

// Minimal .env loader (no dependency). Prefers Node's native loader
// (process.loadEnvFile, Node 20.6+) with a tiny fallback parser.
export function loadDotEnv(cwd = process.cwd()): void {
  const p = path.join(cwd, ".env");
  if (!fs.existsSync(p)) return;
  const native = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof native === "function") {
    // Native loader does not override existing env vars — same contract.
    native.call(process, p);
    return;
  }
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
