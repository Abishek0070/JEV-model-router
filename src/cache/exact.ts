import crypto from "node:crypto";
import type { ChatRequest, ProviderResult } from "../types.js";

type Entry = { result: ProviderResult & { provider: string; model: string; tier?: string; confidence?: number }; expiresAt: number };

const store = new Map<string, Entry>();

export function exactKey(req: ChatRequest): string {
  const norm = JSON.stringify({
    m: req.messages,
    t: req.temperature ?? 1,
    mt: req.max_tokens ?? null,
    tp: req.top_p ?? null,
    s: req.stop ?? null,
    seed: req.seed ?? null,
    tools: req.tools ?? null,
    tc: req.tool_choice ?? null,
    rf: req.response_format ?? null,
  });
  return crypto.createHash("sha256").update(norm).digest("hex");
}

export function exactGet(key: string): Entry["result"] | null {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    store.delete(key);
    return null;
  }
  return e.result;
}

export function exactSet(key: string, result: Entry["result"], ttlMs: number): void {
  store.set(key, { result, expiresAt: Date.now() + ttlMs });
}
