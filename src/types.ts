export type Tier = "fast" | "balanced" | "powerful";

export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; name?: string };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  seed?: number;
  stream?: boolean;
  // Opaque passthrough for tool/function calling. Forwarded to providers
  // that accept OpenAI-style tools; stripped (and logged) elsewhere.
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
};

export type JevDecision = {
  tier: Tier;
  confidence: number;
  probabilities?: Record<string, number>;
  escalation?: boolean;
};

export type ModelMeta = {
  provider: string;
  upstreamModel: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  quality: number;
  latencyMs: number;
};

export type RoutePolicy = {
  priority: "cost" | "latency" | "quality";
  allow: string[];
  max_cost_usd: number;
  allowEscalation?: boolean;
};

export type AppConfig = {
  server: { port: number };
  tiers: Record<Tier, string[]>;
  models: Record<string, ModelMeta>;
  routes: Record<string, RoutePolicy>;
  jev: {
    order: string[];
    timeoutMs: number;
    thresholds: { review: number };
    breaker: { tripAfterFails: number; cooldownMs: number };
  };
  cache: {
    exact: { enabled: boolean; ttlMs: number };
  };
  dispatcher: { perAttemptTimeoutMs: number; maxAttemptsPerModel: number; backoffMs: number[] };
};

export type ProviderResult = {
  content: string;
  inputTokens: number;
  outputTokens: number;
  upstreamModel: string;
};

export type TelemetryEvent = {
  request_id: string;
  route: string;
  jev: { tier: Tier; confidence: number; probabilities?: Record<string, number>; latency_ms: number; provider_used: string };
  policy: { priority: string; eligible: string[] };
  selected: { provider: string; model: string; upstream: string };
  scoring: { score: number; reason: string };
  latency: { cache_ms: number; jev_ms: number; policy_ms: number; provider_ms: number; router_ms: number; total_ms: number };
  cost_usd: number;
  fallback: boolean;
  cached: boolean;
  warnings?: string[];
  error?: string;
};
