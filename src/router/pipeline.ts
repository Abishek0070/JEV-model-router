import type { AppConfig, ChatRequest, Tier } from "../types.js";
import { eligibleModels, maybeEscalate } from "../policy/engine.js";
import { scoreCandidates } from "../scoring/scorer.js";
import type { JevRouter } from "../jev/index.js";

export type PipelineScored = { id: string; score: number; reason: string };

export type PipelineResult = {
  tier: Tier;
  confidence: number;
  probabilities?: Record<string, number>;
  jevProviderUsed: string;
  jev_ms: number;
  policy_ms: number;
  eligible: string[];
  scored: PipelineScored[];
};

// Shared JEV -> policy -> scoring pipeline. Never calls an LLM.
// Used by the HTTP server and the in-process library entry alike.
export async function runPipeline(
  cfg: AppConfig,
  jev: JevRouter,
  chatReq: ChatRequest,
  route: string,
): Promise<PipelineResult> {
  const policy0 = performance.now();
  const policy = cfg.routes[route];
  const explicitId = chatReq.model && cfg.models[chatReq.model] ? chatReq.model : null;
  if (explicitId) {
    return {
      tier: "balanced", confidence: 1, jevProviderUsed: "bypass", jev_ms: 0,
      policy_ms: performance.now() - policy0,
      eligible: [explicitId], scored: [{ id: explicitId, score: 1, reason: "explicit-model-bypass" }],
    };
  }
  const state = chatReq.messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 6000);
  const r = await jev.decide(state);
  const policyEnd = performance.now();
  let tier = r.decision.tier;
  const effective = maybeEscalate(tier, r.decision.confidence, cfg.jev.thresholds.review, policy.allowEscalation !== false || !!r.decision.escalation);
  if (effective !== tier) tier = effective;
  let eligible = eligibleModels(cfg, tier, route);
  if (eligible.length === 0) eligible = policy.allow.filter((id) => cfg.models[id]);
  const scored = scoreCandidates(cfg, eligible, policy.priority, Math.ceil(state.length / 4));
  return {
    tier, confidence: r.decision.confidence, probabilities: r.decision.probabilities,
    jevProviderUsed: r.providerUsed, jev_ms: r.latencyMs,
    policy_ms: Math.max(0, performance.now() - policyEnd), eligible, scored,
  };
}

export function planFor(cfg: AppConfig, scored: PipelineScored[]): { modelId: string; provider: string; upstream: string }[] {
  return scored.map((s) => ({ modelId: s.id, provider: cfg.models[s.id].provider, upstream: cfg.models[s.id].upstreamModel }));
}

export function costOf(cfg: AppConfig, modelId: string, inT: number, outT: number): number {
  const m = cfg.models[modelId];
  return (inT * m.inputCostPer1M + outT * m.outputCostPer1M) / 1_000_000;
}

export function routeFor(cfg: AppConfig, model: string): string {
  if (model in cfg.routes) return model;
  return "chat.default";
}
