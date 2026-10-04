import type { JevDecision, Tier } from "../types.js";

export interface JevProvider {
  name: string;
  decide(state: string): Promise<JevDecision>;
}

export function clampConfidence(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function toTier(choice: string): Tier {
  const v = choice.toLowerCase();
  if (v.includes("power")) return "powerful";
  if (v.includes("balanc")) return "balanced";
  return "fast";
}

export function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}
