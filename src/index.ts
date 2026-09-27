import { loadConfig } from "./config.js";
import { exactGet, exactKey, exactSet } from "./cache/exact.js";
import { dispatch } from "./dispatcher/index.js";
import { buildProviders } from "./providers/registry.js";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible.js";
import { scoreCandidates } from "./scoring/scorer.js";
import { JevRouter } from "./jev/index.js";
import { costOf, planFor, routeFor, runPipeline, type PipelineResult } from "./router/pipeline.js";
import type { AppConfig, ChatRequest } from "./types.js";

// In-process entry: embed the router INSIDE your production app —
// no HTTP hop, no separate process. Your app owns auth/TLS/scaling.
//
//   const router = await createRouter();
//   const res = await router.chat({ model: "auto", messages });
//   // -> { content, model, provider, tier, confidence, usage, cost_usd, ... }

export type RouterChatInput = ChatRequest & { route?: string };

export type RouterChatResult = {
  content: string;
  model: string;
  provider: string;
  upstream: string;
  tier: string;
  confidence: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  cost_usd: number;
  fallback: boolean;
  cached: boolean;
  warnings: string[];
};

export async function createRouter(opts?: { configPath?: string }): Promise<{
  config: AppConfig;
  chat: (input: RouterChatInput) => Promise<RouterChatResult>;
  stream: (input: RouterChatInput) => AsyncGenerator<string, RouterChatResult, void>;
  decide: (state: string, route?: string) => Promise<PipelineResult>;
}> {
  if (opts?.configPath) process.env.CONFIG_PATH = opts.configPath;
  const cfg = loadConfig();
  const jev = new JevRouter(cfg);
  const providers = buildProviders();

  async function chat(input: RouterChatInput): Promise<RouterChatResult> {
    if (input.stream) throw new Error("in-process chat() is non-streaming; use router.stream() or the HTTP SSE endpoint");
    const route = input.route && cfg.routes[input.route] ? input.route : routeFor(cfg, input.model || "auto");
    const policy = cfg.routes[route];
    const key = exactKey(input);
    const cached = cfg.cache.exact.enabled ? exactGet(key) : null;
    if (cached) {
      return {
        content: cached.content, model: cached.model, provider: cached.provider, upstream: cached.upstreamModel,
        tier: cached.tier || "balanced", confidence: cached.confidence ?? 1,
        usage: { prompt_tokens: cached.inputTokens, completion_tokens: cached.outputTokens, total_tokens: cached.inputTokens + cached.outputTokens },
        cost_usd: 0, fallback: false, cached: true, warnings: [],
      };
    }
    const pipe = await runPipeline(cfg, jev, input, route);
    let plan = planFor(cfg, pipe.scored);
    const warnings: string[] = [];
    let d: Awaited<ReturnType<typeof dispatch>>;
    try {
      d = await dispatch(cfg, providers, plan, input.messages, { maxTokens: input.max_tokens, temperature: input.temperature, tools: input.tools, tool_choice: input.tool_choice, response_format: input.response_format });
    } catch {
      const tried = new Set(plan.map((p) => p.modelId));
      const rest = policy.allow.filter((id) => cfg.models[id] && !tried.has(id));
      if (rest.length === 0) throw new Error("all providers failed");
      const restScored = scoreCandidates(cfg, rest, policy.priority, 1000);
      plan = restScored.map((s) => ({ modelId: s.id, provider: cfg.models[s.id].provider, upstream: cfg.models[s.id].upstreamModel }));
      d = await dispatch(cfg, providers, plan, input.messages, { maxTokens: input.max_tokens, temperature: input.temperature, tools: input.tools });
      d.fallback = true;
    }
    if (input.tools && (d.provider === "anthropic" || d.provider === "gemini")) {
      warnings.push(`tools stripped: ${d.provider} target does not accept OpenAI-style tools in v0.2`);
    }
    const cost_usd = costOf(cfg, d.model, d.result.inputTokens, d.result.outputTokens);
    if (cfg.cache.exact.enabled) exactSet(key, { ...d.result, provider: d.provider, model: d.model, tier: pipe.tier, confidence: pipe.confidence }, cfg.cache.exact.ttlMs);
    return {
      content: d.result.content, model: d.model, provider: d.provider, upstream: d.result.upstreamModel,
      tier: pipe.tier, confidence: pipe.confidence,
      usage: { prompt_tokens: d.result.inputTokens, completion_tokens: d.result.outputTokens, total_tokens: d.result.inputTokens + d.result.outputTokens },
      cost_usd, fallback: d.fallback, cached: false, warnings,
    };
  }

  async function* stream(input: RouterChatInput): AsyncGenerator<string, RouterChatResult, void> {
    const route = input.route && cfg.routes[input.route] ? input.route : routeFor(cfg, input.model || "auto");
    const pipe = await runPipeline(cfg, jev, input, route);
    const plan = planFor(cfg, pipe.scored);
    let selected = plan[0];
    let content = "";
    let inT = 0;
    let outT = 0;
    let fallback = false;
    let first = true;
    for (const step of plan) {
      const p = providers.get(step.provider);
      try {
        if (p instanceof OpenAICompatibleProvider) {
          const r = await p.stream(input.messages, step.upstream, {
            maxTokens: input.max_tokens, temperature: input.temperature, timeoutMs: cfg.dispatcher.perAttemptTimeoutMs,
            tools: input.tools, tool_choice: input.tool_choice,
          }, () => {});
          // Upstream is buffered by p.stream; re-emit in slices so callers
          // can forward progressively.
          const CH = 120;
          for (let i = 0; i < r.content.length; i += CH) yield r.content.slice(i, i + CH);
          content = r.content;
          inT = r.inputTokens;
          outT = r.outputTokens;
        } else {
          const d = await dispatch(cfg, providers, [step], input.messages, { maxTokens: input.max_tokens, temperature: input.temperature, tools: input.tools });
          yield d.result.content;
          content = d.result.content;
          inT = d.result.inputTokens;
          outT = d.result.outputTokens;
        }
        selected = step;
        fallback = !first;
        break;
      } catch {
        first = false;
        continue;
      }
    }
    if (!content) throw new Error("all providers failed");
    const cost_usd = costOf(cfg, selected.modelId, inT, outT);
    return {
      content, model: selected.modelId, provider: selected.provider, upstream: selected.upstream,
      tier: pipe.tier, confidence: pipe.confidence,
      usage: { prompt_tokens: inT, completion_tokens: outT, total_tokens: inT + outT },
      cost_usd, fallback, cached: false, warnings: [],
    };
  }

  async function decide(state: string, route = "chat.default"): Promise<PipelineResult> {
    return runPipeline(cfg, jev, { model: "auto", messages: [{ role: "user", content: state }] }, route);
  }

  return { config: cfg, chat, stream, decide };
}
