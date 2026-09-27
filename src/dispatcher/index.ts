import type { AppConfig, ChatMessage, ProviderResult } from "../types.js";
import { isRetryableStatus } from "../providers/base.js";
import type { LLMProvider } from "../providers/base.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DispatchPlan = { modelId: string; provider: string; upstream: string }[];
export type DispatchOpts = { maxTokens?: number; temperature?: number; tools?: unknown; tool_choice?: unknown; response_format?: unknown };

// Calls candidates in scored order. Same-model retries with backoff, then next model.
// Returns first success. fallback=true when more than one attempt was needed.
export async function dispatch(
  cfg: AppConfig,
  providers: Map<string, LLMProvider>,
  plan: DispatchPlan,
  messages: ChatMessage[],
  opts: DispatchOpts,
): Promise<{ result: ProviderResult; provider: string; model: string; attempts: number; fallback: boolean; latencyMs: number }> {
  const t0 = performance.now();
  let attempts = 0;
  let lastErr: unknown = null;

  for (const step of plan) {
    const p = providers.get(step.provider);
    if (!p) continue;
    for (let a = 0; a < cfg.dispatcher.maxAttemptsPerModel; a++) {
      attempts += 1;
      try {
        const result = await p.chat(messages, step.upstream, {
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          timeoutMs: cfg.dispatcher.perAttemptTimeoutMs,
          tools: opts.tools,
          tool_choice: opts.tool_choice,
          response_format: opts.response_format,
        });
        return { result, provider: step.provider, model: step.modelId, attempts, fallback: attempts > 1, latencyMs: performance.now() - t0 };
      } catch (e) {
        lastErr = e;
        const status = (e as { status?: number }).status ?? 0;
        const retryable = status === 0 || isRetryableStatus(status);
        if (!retryable) break; // caller error / auth — try next model immediately
        const backoffs = cfg.dispatcher.backoffMs;
        if (a < backoffs.length) await sleep(backoffs[a]);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("all providers failed");
}
