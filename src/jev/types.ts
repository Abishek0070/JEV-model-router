import type { JevDecision, Tier } from "../types.js";

export interface JevProvider {
  name: string;
  decide(state: string): Promise<JevDecision>;
}

export function clampConfidence(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function tierOrder(t: Tier): number {
  return t === "fast" ? 0 : t === "balanced" ? 1 : 2;
}
