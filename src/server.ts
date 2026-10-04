import Fastify from "fastify";
import cors from "@fastify/cors";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { exactGet, exactKey, exactSet } from "./cache/exact.js";
import { dispatch } from "./dispatcher/index.js";
import { checkAuth, checkQuota } from "./ingress/auth.js";
import { buildProviders } from "./providers/registry.js";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible.js";
import { scoreCandidates } from "./scoring/scorer.js";
import { costOf, planFor, routeFor, runPipeline } from "./router/pipeline.js";
import { emitTelemetry, logger, recentTelemetry } from "./telemetry/logger.js";
import { JevRouter } from "./jev/index.js";
import { loadDotEnv } from "./dotenv.js";
import type { ChatRequest } from "./types.js";

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  const jev = new JevRouter(cfg);
  const providers = buildProviders();
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // Startup report: key names only, never values. This is the
  // "did I configure my JEV key correctly?" check.
  logger.info(
    {
      port: cfg.server.port,
      jev: {
        order: cfg.jev.order,
        jevmodel_configured: Boolean(process.env.JEVMODEL_API_KEY || process.env.JEV_API_KEY),
        typesafe_configured: Boolean(process.env.JEV_TYPESAFE_API_KEY || process.env.JEV_API_KEY),
        openrouter_configured: Boolean(process.env.OPENROUTER_API_KEY),
        local_available: true,
      },
      llm: {
        openai: Boolean(process.env.OPENAI_API_KEY),
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
        gemini: Boolean(process.env.GEMINI_API_KEY),
        groq: Boolean(process.env.GROQ_API_KEY),
        ollama: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
        mock: true,
      },
    },
    "jev-router config report",
  );

  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async () => ({ ready: true, jevOrder: cfg.jev.order }));
  app.get("/v1/models", async () => ({
    object: "list",
    data: Object.entries(cfg.models).map(([id, m]) => ({ id, object: "model", provider: m.provider, upstream: m.upstreamModel })),
    tiers: cfg.tiers,
    routes: Object.keys(cfg.routes),
  }));
  app.get("/v1/telemetry/recent", async () => ({ data: recentTelemetry() }));

  // Dry-run: configure your JEV key, then verify routing without spending on LLMs.
  app.post("/v1/routing/decision", async (req, reply) => {
    if (!checkAuth(req.headers.authorization as string | undefined)) return reply.code(401).send({ error: "unauthorized" });
    const body = req.body as { messages?: { role: string; content: string }[]; state?: string; route?: string; model?: string };
    const state = body.state || (body.messages || []).map((m) => `${m.role}: ${m.content}`).join("\n");
    if (!state) return reply.code(400).send({ error: "messages or state required" });
    const route = body.route && cfg.routes[body.route] ? body.route : "chat.default";
    const fake: ChatRequest = { model: body.model || "auto", messages: [{ role: "user", content: state }] };
    const p = await runPipeline(cfg, jev, fake, route);
    return reply.send({
      route,
      tier: p.tier,
      confidence: p.confidence,
      probabilities: p.probabilities,
      jev_provider: p.jevProviderUsed,
      eligible: p.eligible,
      scored: p.scored.map((s) => ({ model: s.id, provider: cfg.models[s.id].provider, score: s.score, reason: s.reason })),
      latency_ms: { jev: p.jev_ms, policy: p.policy_ms },
    });
  });

  app.post("/v1/chat/completions", async (req, reply) => {
    const total0 = performance.now();
    const request_id = `req_${crypto.randomBytes(4).toString("hex")}`;
    const body = req.body as ChatRequest;
    if (!body?.messages?.length) return reply.code(400).send({ error: "messages required" });

    const authHeader = req.headers.authorization as string | undefined;
    if (!checkAuth(authHeader)) return reply.code(401).send({ error: "unauthorized" });
    const quotaId = authHeader || (req.ip as string);
    if (!checkQuota(quotaId)) return reply.code(429).send({ error: "rate limited" });

    const route = routeFor(cfg, body.model || "auto");
    const policy = cfg.routes[route];
    if (!policy) return reply.code(400).send({ error: `unknown route ${route}` });

    const cache0 = performance.now();
    const key = exactKey(body);
    const cached = cfg.cache.exact.enabled && !body.stream ? exactGet(key) : null;
    const cache_ms = performance.now() - cache0;

    const warnings: string[] = [];
    const dispatchOpts = { maxTokens: body.max_tokens, temperature: body.temperature, tools: body.tools, tool_choice: body.tool_choice, response_format: body.response_format };

    const finish = (ev: Parameters<typeof emitTelemetry>[0]) => emitTelemetry({ ...ev, warnings: warnings.length ? warnings : undefined });

    // ---- Streaming path (SSE) ----
    if (body.stream) {
      const pipe = await runPipeline(cfg, jev, body, route);
      const plan = planFor(cfg, pipe.scored);
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      reply.raw.write(`: router tier=${pipe.tier} confidence=${pipe.confidence.toFixed(2)}\n\n`);
      const prov0 = performance.now();
      let selected = plan[0];
      let content = "";
      let inT = 0;
      let outT = 0;
      let fallback = false;
      let first = true;
      let streamError: string | null = null;
      for (const step of plan) {
        const p = providers.get(step.provider);
        try {
          if (p instanceof OpenAICompatibleProvider) {
            const r = await p.stream(body.messages, step.upstream, { ...dispatchOpts, timeoutMs: cfg.dispatcher.perAttemptTimeoutMs }, (line) => {
              reply.raw.write(`${line}\n`);
            });
            content = r.content;
            inT = r.inputTokens;
            outT = r.outputTokens;
          } else {
            // Non-streaming provider: dispatch normally, emit as one SSE chunk.
            const d = await dispatch(cfg, providers, [step], body.messages, dispatchOpts);
            content = d.result.content;
            inT = d.result.inputTokens;
            outT = d.result.outputTokens;
            reply.raw.write(`data: ${JSON.stringify({ id: request_id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: step.modelId, choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\n`);
          }
          selected = step;
          fallback = !first;
          break;
        } catch (e) {
          streamError = e instanceof Error ? e.message : "stream failed";
          first = false;
          continue;
        }
      }
      const provider_ms = performance.now() - prov0;
      if (!content && streamError) {
        reply.raw.write(`data: ${JSON.stringify({ error: streamError })}\n\n`);
        reply.raw.end();
        return reply;
      }
      if (cfg.models[selected.modelId] && (providers.get(selected.provider) instanceof OpenAICompatibleProvider)) {
        // usage already captured from stream; nothing extra to write
      }
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      const m = cfg.models[selected.modelId];
      const cost_usd = m ? costOf(cfg, selected.modelId, inT, outT) : 0;
      const total_ms = performance.now() - total0;
      finish({
        request_id, route,
        jev: { tier: pipe.tier, confidence: pipe.confidence, probabilities: pipe.probabilities, latency_ms: pipe.jev_ms, provider_used: pipe.jevProviderUsed },
        policy: { priority: policy.priority, eligible: pipe.eligible },
        selected: { provider: selected.provider, model: selected.modelId, upstream: selected.upstream },
        scoring: { score: pipe.scored.find((s) => s.id === selected.modelId)?.score ?? 0, reason: "stream" },
        latency: { cache_ms, jev_ms: pipe.jev_ms, policy_ms: pipe.policy_ms, provider_ms, router_ms: cache_ms + pipe.jev_ms + pipe.policy_ms, total_ms },
        cost_usd, fallback, cached: false,
      });
      return reply;
    }

    // ---- Non-streaming path ----
    try {
      if (cached) {
        const total_ms = performance.now() - total0;
        finish({
          request_id, route,
          jev: { tier: (cached.tier as "fast" | "balanced" | "powerful") || "balanced", confidence: cached.confidence ?? 1, latency_ms: 0, provider_used: "cache" },
          policy: { priority: policy.priority, eligible: [] },
          selected: { provider: cached.provider, model: cached.model, upstream: cached.upstreamModel },
          scoring: { score: 0, reason: "exact-cache-hit" },
          latency: { cache_ms, jev_ms: 0, policy_ms: 0, provider_ms: 0, router_ms: cache_ms, total_ms },
          cost_usd: 0, fallback: false, cached: true,
        });
        return reply.send({
          id: request_id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: cached.model,
          choices: [{ index: 0, message: { role: "assistant", content: cached.content }, finish_reason: "stop" }],
          usage: { prompt_tokens: cached.inputTokens, completion_tokens: cached.outputTokens, total_tokens: cached.inputTokens + cached.outputTokens },
        });
      }

      const pipe = await runPipeline(cfg, jev, body, route);
      let plan = planFor(cfg, pipe.scored);
      const top = pipe.scored[0];
      let d: Awaited<ReturnType<typeof dispatch>>;
      try {
        d = await dispatch(cfg, providers, plan, body.messages, dispatchOpts);
      } catch {
        const tried = new Set(plan.map((p) => p.modelId));
        const rest = policy.allow.filter((id) => cfg.models[id] && !tried.has(id));
        if (rest.length === 0) throw new Error("all providers failed");
        const restScored = scoreCandidates(cfg, rest, policy.priority, Math.ceil(body.messages.map((m) => m.content).join("\n").length / 4));
        plan = restScored.map((s) => ({ modelId: s.id, provider: cfg.models[s.id].provider, upstream: cfg.models[s.id].upstreamModel }));
        d = await dispatch(cfg, providers, plan, body.messages, dispatchOpts);
        d.fallback = true;
      }
      if (body.tools && (d.provider === "anthropic" || d.provider === "gemini")) {
        warnings.push(`tools stripped: ${d.provider} target does not accept OpenAI-style tools in v0.2; use an OpenAI-compatible provider for tool calling`);
      }

      const cost_usd = costOf(cfg, d.model, d.result.inputTokens, d.result.outputTokens);
      if (cfg.cache.exact.enabled) exactSet(key, { ...d.result, provider: d.provider, model: d.model, tier: pipe.tier, confidence: pipe.confidence }, cfg.cache.exact.ttlMs);

      const total_ms = performance.now() - total0;
      finish({
        request_id, route,
        jev: { tier: pipe.tier, confidence: pipe.confidence, probabilities: pipe.probabilities, latency_ms: pipe.jev_ms, provider_used: pipe.jevProviderUsed },
        policy: { priority: policy.priority, eligible: pipe.eligible },
        selected: { provider: d.provider, model: d.model, upstream: d.result.upstreamModel },
        scoring: { score: top.score, reason: top.reason },
        latency: { cache_ms, jev_ms: pipe.jev_ms, policy_ms: pipe.policy_ms, provider_ms: d.latencyMs, router_ms: cache_ms + pipe.jev_ms + pipe.policy_ms, total_ms },
        cost_usd, fallback: d.fallback, cached: false,
      });

      return reply.send({
        id: request_id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: d.model,
        choices: [{ index: 0, message: { role: "assistant", content: d.result.content }, finish_reason: "stop" }],
        usage: { prompt_tokens: d.result.inputTokens, completion_tokens: d.result.outputTokens, total_tokens: d.result.inputTokens + d.result.outputTokens },
        _router: { tier: pipe.tier, confidence: pipe.confidence, provider: d.provider, fallback: d.fallback },
      });
    } catch (e) {
      const total_ms = performance.now() - total0;
      const msg = e instanceof Error ? e.message : "dispatch failed";
      const status = (e as { status?: number }).status ?? 502;
      finish({
        request_id, route,
        jev: { tier: "balanced", confidence: 0, latency_ms: 0, provider_used: "error" },
        policy: { priority: policy.priority, eligible: [] },
        selected: { provider: "none", model: "none", upstream: "none" },
        scoring: { score: 0, reason: "error" },
        latency: { cache_ms, jev_ms: 0, policy_ms: 0, provider_ms: 0, router_ms: cache_ms, total_ms },
        cost_usd: 0, fallback: true, cached: false, error: msg,
      });
      return reply.code(status).send({ error: msg });
    }
  });

  // ---- Anthropic ingress: point Anthropic SDK / Claude Code at the router ----
  // SDK baseURL -> http://host:4000 (it appends /v1/messages). Non-streaming in v0.2.
  app.post("/v1/messages", async (req, reply) => {
    const authHeader = (req.headers["x-api-key"] as string) || req.headers.authorization;
    if (!checkAuth(typeof authHeader === "string" && authHeader.startsWith("Bearer") ? authHeader : authHeader ? `Bearer ${(authHeader as string).replace(/^Bearer\s+/i, "")}` : undefined)) {
      return reply.code(401).send({ type: "error", error: { type: "authentication_error", message: "unauthorized" } });
    }
    const quotaId = (typeof authHeader === "string" ? authHeader : req.ip) as string;
    if (!checkQuota(quotaId)) return reply.code(429).send({ type: "error", error: { type: "rate_limit_error", message: "rate limited" } });
    const body = req.body as {
      model: string; system?: string | { type: string; text?: string }[];
      messages: { role: string; content: string | { type: string; text?: string }[] }[];
      max_tokens: number; temperature?: number; stream?: boolean;
    };
    if (body.stream) return reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: "streaming on /v1/messages is not supported in v0.2; use POST /v1/chat/completions with stream:true" } });
    if (!body?.messages?.length) return reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: "messages required" } });

    const textOf = (c: string | { type: string; text?: string }[] | undefined): string => {
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.filter((b) => b.type === "text" && b.text).map((b) => b.text as string).join("\n");
      return "";
    };
    const systemText = typeof body.system === "string" ? body.system : Array.isArray(body.system) ? textOf(body.system) : "";
    const chatReq: ChatRequest = {
      model: body.model || "auto",
      messages: [
        ...(systemText ? [{ role: "system" as const, content: systemText }] : []),
        ...body.messages.map((m) => ({ role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant", content: textOf(m.content) })),
      ],
      max_tokens: body.max_tokens,
      temperature: body.temperature,
    };
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", payload: chatReq,
      headers: { authorization: typeof authHeader === "string" && authHeader.startsWith("Bearer") ? authHeader : `Bearer ${authHeader || ""}` },
    });
    const json = res.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string; error?: unknown };
    if (res.statusCode !== 200) return reply.code(res.statusCode).send({ type: "error", error: { type: "api_error", message: String((json as { error?: unknown }).error || "dispatch failed") } });
    const text = json.choices?.[0]?.message?.content || "";
    return reply.send({
      id: `msg_${crypto.randomBytes(6).toString("hex")}`,
      type: "message", role: "assistant", model: json.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0 },
    });
  });

  app.post("/v1/completions", async (req, reply) => {
    const body = req.body as { model: string; prompt: string; max_tokens?: number; temperature?: number };
    if (!body?.prompt) return reply.code(400).send({ error: "prompt required" });
    const chatBody: ChatRequest = { model: body.model, messages: [{ role: "user", content: body.prompt }], max_tokens: body.max_tokens, temperature: body.temperature };
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: chatBody, headers: { authorization: req.headers.authorization as string } });
    const json = res.json() as { choices?: { message?: { content?: string } }[]; usage?: unknown; id?: string; model?: string; error?: unknown };
    if (res.statusCode !== 200) return reply.code(res.statusCode).send(json);
    return reply.send({ id: json.id, object: "text_completion", created: Math.floor(Date.now() / 1000), model: json.model, choices: [{ text: json.choices?.[0]?.message?.content || "", finish_reason: "stop" }], usage: json.usage });
  });

  await app.listen({ port: cfg.server.port, host: "0.0.0.0" });
  logger.info({ port: cfg.server.port }, "jev-router listening");
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
