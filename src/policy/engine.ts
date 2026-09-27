import type { AppConfig, Tier } from "../types.js";
import { tierOrder } from "../jev/types.js";

// Policy engine: tier ∩ route.allow, minus over-budget models.
// JEV is never consulted here — it only supplied the tier upstream.
export function eligibleModels(cfg: AppConfig, tier: Tier, route: string): string[] {
  const policy = cfg.routes[route];
  if (!policy) return [];
  const inTier = new Set(cfg.tiers[tier] || []);
  // Rough cost gate: assume ~1k input + 300 output tokens for admission.
  const est = (id: string): number => {
    const m = cfg.models[id];
    if (!m) return Infinity;
    return (m.inputCostPer1M * 1000 + m.outputCostPer1M * 300) / 1_000_000;
  };
  return policy.allow.filter((id) => inTier.has(id) && cfg.models[id] && est(id) <= policy.max_cost_usd);
}

// If JEV confidence is below review threshold and escalation is allowed,
// consider one tier up as well (still constrained by route.allow).
export function maybeEscalate(tier: Tier, confidence: number, reviewThreshold: number, allowEscalation: boolean): Tier {
  if (!allowEscalation || confidence >= reviewThreshold) return tier;
  if (tier === "fast") return "balanced";
  if (tier === "balanced") return "powerful";
  return tier;
}

export function tierRank(t: Tier): number {
  return tierOrder(t);
}
