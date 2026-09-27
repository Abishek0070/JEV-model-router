import type { AppConfig } from "../types.js";

// score = w_quality * p_success - w_cost * norm_cost - w_latency * norm_latency
const WEIGHTS: Record<string, { q: number; c: number; l: number }> = {
  cost: { q: 0.4, c: 0.5, l: 0.1 },
  latency: { q: 0.3, c: 0.2, l: 0.5 },
  quality: { q: 0.7, c: 0.15, l: 0.15 },
};

export function scoreCandidates(
  cfg: AppConfig,
  ids: string[],
  priority: string,
  estInputTokens = 1000,
): { id: string; score: number; reason: string }[] {
  const w = WEIGHTS[priority] || WEIGHTS.cost;
  const costs = ids.map((id) => {
    const m = cfg.models[id];
    return (m.inputCostPer1M * estInputTokens + m.outputCostPer1M * 300) / 1_000_000;
  });
  const lats = ids.map((id) => cfg.models[id].latencyMs);
  const maxC = Math.max(...costs, 1e-9);
  const maxL = Math.max(...lats, 1);
  return ids
    .map((id, i) => {
      const m = cfg.models[id];
      const nc = costs[i] / maxC;
      const nl = lats[i] / maxL;
      const score = w.q * m.quality - w.c * nc - w.l * nl;
      return {
        id,
        score,
        reason: `q=${m.quality} c=$${costs[i].toFixed(5)} l=${m.latencyMs}ms w=${priority}`,
      };
    })
    .sort((a, b) => b.score - a.score);
}
