# jev-router

[![npm version](https://img.shields.io/npm/v/@abishek0070/jev-model-router.svg)](https://www.npmjs.com/package/@abishek0070/jev-model-router)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

```bash
npx @abishek0070/jev-model-router init
npx @abishek0070/jev-model-router start
```

Open-source production model router where **JEV decides what level of model capability a request needs. The policy engine decides which models are acceptable, and the scoring engine chooses the actual model based on application constraints.**

JEV never selects a provider or model directly — it returns a routing tier (`fast` | `balanced` | `powerful`). Policy + scoring choose the final model, so you can change models and providers without touching JEV.

## Quick start

**From npm (easiest):**

```bash
npx @abishek0070/jev-model-router init   # creates jev-router.config.yaml + .env, asks for JEV key
# add one LLM key to .env, then:
npx @abishek0070/jev-model-router start  # gateway on http://localhost:4000/v1
```

**From source:**

```bash
npm install
cp .env.example .env   # optional — dev works with zero keys
npm run dev
# or: docker compose up
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:4000/v1", api_key="project-key")
r = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Explain this Kubernetes error"}])
print(r.choices[0].message.content)
```

No keys needed for dev — requests serve via `mock-echo` + local JEV heuristic.

## End-to-end pipeline architecture

```text
                 ┌──────────────────┐
                 │     User App     │
                 └────────┬─────────┘
                          │  OpenAI SDK ──► POST /v1/chat/completions (streaming + tools)
                          │  Anthropic SDK ─► POST /v1/messages (non-streaming)
                          │  In-process ────► router.chat() / router.stream() (no HTTP)
                          ▼
                 ┌──────────────────┐
                 │     Ingress      │  Auth (GATEWAY_API_KEYS, open in dev)
                 │  Auth / Quota    │  Quota: 60 req/min per key (in-memory)
                 └────────┬─────────┘
                          ▼
                 ┌──────────────────┐
                 │   Exact Cache    │  SHA-256 over messages + sampling params
                 │  (SHA-256, TTL)  │  + tools. Hit → respond immediately.
                 └────────┬─────────┘  Cached hits keep the original tier.
                          │ miss
                          ▼
                 ┌──────────────────┐
                 │       JEV        │  Tries jev.order in sequence:
                 │  Routing Brain   │  typesafe (800ms timeout) → openrouter
                 │  (tier only)     │  → local heuristic (always available).
                 └────────┬─────────┘  Per-endpoint circuit breaker
                          │            (5 fails → 30s cooldown).
                 fast / balanced / powerful (+ confidence, probabilities)
                          │
                          ▼
                 ┌──────────────────┐
                 │  Policy Engine   │  eligible = tiers[tier] ∩ routes[route].allow
                 │                  │  minus models over max_cost_usd.
                 └────────┬─────────┘  Low confidence can escalate one tier
                          │            (still constrained by allow).
                          ▼
                 ┌──────────────────┐
                 │  Model Scoring   │  score = w_quality·p_success
                 │ cost/quality/lat │        − w_cost·norm_cost
                 └────────┬─────────┘        − w_lat·norm_latency
                          │            weights from routes[route].priority
                          ▼
                 ┌──────────────────┐
                 │   Dispatcher     │  In scored order. Same-model retries
                 │  retry/fallback  │  with backoff (100ms, 300ms) on 429/5xx/
                 └────────┬─────────┘  timeouts only; then next model; then
                          │            remaining route.allow models.
             ┌────────────┼────────────┐
             ▼            ▼            ▼
          OpenAI       Anthropic      Groq / Gemini / Ollama / Mock
             │            │            │
             └────────────┼────────────┘
                          ▼
                       Response ──► OpenAI shape, Anthropic shape,
                          │         or SSE stream (OpenAI-compatible
                          ▼         providers stream; others emit one chunk)
                 ┌──────────────────┐
                 │    Telemetry     │  Structured JSON per request + pino log.
                 │                  │  GET /v1/telemetry/recent (last 100).
                 └──────────────────┘
```

### Stage-by-stage

| # | Stage | What happens | Code |
|---|-------|--------------|------|
| 1 | Ingress | `POST /v1/chat/completions` (OpenAI, `stream` + `tools` supported), `POST /v1/messages` (Anthropic, non-streaming), `POST /v1/completions` (legacy). Gateway key check (skipped when `GATEWAY_API_KEYS` is empty), per-key quota. | `src/server.ts`, `src/ingress/auth.ts` |
| 2 | Exact cache | Key = SHA-256 of messages, temperature, max_tokens, top_p, stop, seed, tools, tool_choice, response_format. TTL 1h. Streaming requests bypass the cache read. | `src/cache/exact.ts` |
| 3 | JEV decision | State = concatenated messages (6k chars). One of three endpoints answers with `{ tier, confidence, probabilities }`. Explicit model ids bypass JEV for debugging. | `src/jev/typesafe.ts`, `src/jev/openrouter.ts`, `src/jev/local.ts`, `src/jev/index.ts` |
| 4 | Tier | `fast` \| `balanced` \| `powerful`. If confidence < `jev.thresholds.review` (default 0.60) and the route allows escalation, the tier moves up one level. | `src/jev/types.ts`, `src/policy/engine.ts` |
| 5 | Policy engine | `eligible = tiers[tier] ∩ routes[route].allow`, dropping models whose estimated cost (1k in + 300 out tokens) exceeds `max_cost_usd`. Empty result falls back to all of `route.allow`. | `src/policy/engine.ts` |
| 6 | Scoring | Candidates normalized on cost/latency and ranked. Weights: `cost → {q .4, c .5, l .1}`, `latency → {.3, .2, .5}`, `quality → {.7, .15, .15}`. | `src/scoring/scorer.ts` |
| 7 | Dispatcher | Tries the plan in scored order, 2 attempts per model, 30s per-attempt timeout. Auth/caller errors (4xx) skip to the next model immediately. `fallback: true` when more than one attempt was needed. | `src/dispatcher/index.ts` |
| 8 | Providers | OpenAI/Groq/Ollama share the OpenAI-compatible adapter (`tools`, `tool_choice`, `response_format` forwarded; SSE streaming supported). Anthropic and Gemini use minimal message translation; OpenAI-style tools are stripped there with a telemetry warning. Mock serves dev traffic with zero spend. | `src/providers/openaiCompatible.ts`, `src/providers/native.ts`, `src/providers/registry.ts` |
| 9 | Telemetry | Every request emits `request_id, route, jev{tier, confidence, provider_used}, policy{priority, eligible}, selected{provider, model}, scoring{score, reason}, latency{cache/jev/policy/provider/router/total}, cost_usd, fallback, cached, warnings`. | `src/telemetry/logger.ts` |

The shared core (`src/router/pipeline.ts`: JEV → policy → scoring, plus cost math) is used by both the HTTP server and the in-process library, so the two paths can never drift.

### Worked example

Request: `"Prove that Raft guarantees leader completeness"` with `model: "auto"`.

1. Cache miss → JEV (local) returns `{ tier: "powerful", confidence: 0.81 }`.
2. Policy: `tiers[powerful] ∩ chat.default.allow` → `[claude-sonnet, gpt-reasoning, mock-echo]`.
3. Scoring (`priority: cost`): mock wins on cost in dev; with real keys and mock removed, `gpt-reasoning` outscores `claude-sonnet` on cost.
4. Dispatcher calls the winner; usage → `cost_usd`; response returns with `_router: { tier, confidence, provider }`; telemetry records the full decision chain.

Try it without spending anything:

```bash
curl -X POST http://localhost:4000/v1/routing/decision \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Prove Raft leader completeness"}]}'
# -> { tier: "powerful", confidence, eligible, scored: [...] }
```

## Configuration

See `config.example.yaml`. Key sections:

```yaml
tiers: { fast: [...], balanced: [...], powerful: [...] }
routes: { chat.default: { priority: cost, allow: [...], max_cost_usd: 0.01 } }
jev:
  order: [typesafe, openrouter, local]
  timeoutMs: 800
  thresholds: { auto: 0.85, review: 0.60 }  # starting points — tune via eval
cache:
  exact: { enabled: true, ttlMs: 3600000 }
  semantic: { enabled: false, threshold: 0.92, embedding: { provider: local } }
dispatcher: { perAttemptTimeoutMs: 30000, maxAttemptsPerModel: 2, backoffMs: [100, 300] }
```

`jev.thresholds` are starting points only, not calibrated claims. Measure and tune:

```bash
npm run eval
# accuracy + confidence bucket -> observed accuracy, e.g. 0.80-0.90 -> 0.75
```

Semantic caching is an optional module (`src/cache/semantic/embedding.ts` with `LocalEmbeddingProvider` default, `OpenAIEmbeddingProvider` available). Enable it without changing core routing; the default local embedding costs nothing.

## Plug into any app

**Option A — sidecar (HTTP, any language).**

1. Set one key: `JEV_API_KEY=<typesafe-key>` (or `OPENROUTER_API_KEY=`). No JEV key? Local heuristic routes until you add one.
2. Add one LLM key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`) or run Ollama locally. Remove `mock-echo` from `tiers`/`allow` in prod.
3. `docker compose up`, point the client at `http://localhost:4000/v1`, use `model: "auto"`.

```python
# OpenAI SDK (streaming + tools work)
from openai import OpenAI
client = OpenAI(base_url="http://localhost:4000/v1", api_key="project-key")
r = client.chat.completions.create(model="auto", messages=[...], stream=True)
```

```ts
// Anthropic SDK / Claude Code (non-streaming in v0.2)
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "http://localhost:4000", apiKey: "project-key" });
await client.messages.create({ model: "auto", max_tokens: 512, messages: [...] });
```

**Option B — inside your app (in-process, Node.js).**

```bash
npm install @abishek0070/jev-model-router
```

No HTTP hop, no separate process. Same pipeline, shared exact cache. Your app owns auth/TLS/scaling.

```ts
import { createRouter } from "@abishek0070/jev-model-router";

const router = await createRouter({
  env: { JEV_API_KEY: process.env.JEV_API_KEY }, // or rely on .env / shell env
});

const res = await router.chat({
  model: "auto",
  messages: [{ role: "user", content: "Explain this Kubernetes error" }],
});
// res -> { content, model, provider, tier, confidence, usage, cost_usd, fallback, cached }

for await (const chunk of router.stream({ model: "auto", messages })) {
  process.stdout.write(chunk); // text chunks; final return value has the full result
}

const d = await router.decide("Prove Raft leader completeness"); // dry-run, no LLM call
```

## API

- `POST /v1/chat/completions` (`model: "auto"` routes via JEV; explicit model id bypasses JEV; `stream: true` returns SSE)
- `POST /v1/messages` (Anthropic ingress, non-streaming)
- `POST /v1/routing/decision` (dry-run: tier + scored candidates, no LLM call)
- `POST /v1/completions`, `GET /v1/models`, `GET /health`, `GET /ready`, `GET /v1/telemetry/recent`

Every response to a routed request carries `_router: { tier, confidence, provider, fallback }`; every request emits the telemetry event described above, so you can always answer why a model was chosen, what JEV thought, which policy applied, what it cost, and whether fallback or cache was involved.

## Project structure

```text
src/
  server.ts                  # HTTP layer: routes, SSE, Anthropic ingress, telemetry wiring
  index.ts                   # In-process library: createRouter() -> { chat, stream, decide }
  router/pipeline.ts         # Shared core: runPipeline, planFor, costOf, routeFor
  config.ts / types.ts
  jev/                       # typesafe.ts, openrouter.ts, local.ts, index.ts (failover+breaker)
  policy/engine.ts           # tier ∩ allow, cost gate, escalation
  scoring/scorer.ts          # quality/cost/latency scoring
  providers/                 # base.ts, openaiCompatible.ts (+stream), native.ts, registry.ts
  dispatcher/index.ts        # retries + cross-model / cross-tier fallback
  cache/                     # exact.ts, semantic/embedding.ts (optional)
  ingress/auth.ts            # gateway keys + in-memory quota
  telemetry/logger.ts        # pino JSON log + recent buffer
eval/
  dataset.jsonl / calibrate.ts  # accuracy + confidence-bucket calibration
config.example.yaml  Dockerfile  docker-compose.yml
```

## Performance

Target `router_ms p95 < 10ms` (cache + JEV + policy only; provider latency excluded and reported separately as `provider_ms`). Measured warmed `router_ms` 0.8–4ms on dev hardware; first-hit cold starts higher. Distinguish the two in telemetry — provider inference always dominates total latency.

## Limits (v0.2)

- Anthropic ingress is non-streaming; use the OpenAI endpoint for SSE.
- OpenAI-style `tools` reach OpenAI-compatible providers only; they are stripped (with a telemetry warning) for Anthropic/Gemini targets.
- Quotas are in-memory per instance; use Redis for multi-replica enforcement.
- Terminate TLS at your ingress; the gateway serves plain HTTP.

## License

MIT — see LICENSE.
