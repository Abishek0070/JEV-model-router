import type { ChatMessage, ProviderResult } from "../types.js";
import { estimateTokens, fetchWithTimeout, type LLMProvider, type ProviderCallOpts } from "./base.js";

// Generic OpenAI-compatible chat provider (OpenAI, Groq, Ollama/vLLM, etc.)
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    public name: string,
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private body(messages: ChatMessage[], upstreamModel: string, opts: ProviderCallOpts, stream: boolean): Record<string, unknown> {
    return {
      model: upstreamModel,
      messages,
      max_tokens: opts.maxTokens ?? 512,
      temperature: opts.temperature ?? 0.7,
      stream,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
      ...(opts.response_format ? { response_format: opts.response_format } : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
  }

  async chat(messages: ChatMessage[], upstreamModel: string, opts: ProviderCallOpts): Promise<ProviderResult> {
    if (!this.apiKey && this.name !== "mock") {
      // Allow empty key for local servers like Ollama.
      if (this.name !== "ollama") throw Object.assign(new Error(`${this.name}: missing API key`), { status: 401 });
    }
    const res = await fetchWithTimeout(
      `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(this.body(messages, upstreamModel, opts, false)),
      },
      opts.timeoutMs,
    );
    if (!res.ok) {
      const err = new Error(`${this.name} status ${res.status}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: unknown } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content || "";
    const inT = json.usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join("\n"));
    const outT = json.usage?.completion_tokens ?? estimateTokens(content);
    return { content, inputTokens: inT, outputTokens: outT, upstreamModel };
  }

  // Streams OpenAI-style SSE lines to onLine (raw `data: ...` lines, no trailing newline).
  // Resolves with accumulated text + usage for cost/telemetry.
  async stream(
    messages: ChatMessage[],
    upstreamModel: string,
    opts: ProviderCallOpts,
    onLine: (line: string) => void,
  ): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
    if (!this.apiKey && this.name !== "ollama") throw Object.assign(new Error(`${this.name}: missing API key`), { status: 401 });
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 300_000);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: c.signal,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(this.body(messages, upstreamModel, opts, true)),
      });
      if (!res.ok || !res.body) throw Object.assign(new Error(`${this.name} stream status ${res.status}`), { status: res.status });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let content = "";
      let inT = 0;
      let outT = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith("data:")) continue;
          onLine(s);
          const payload = s.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            content += j.choices?.[0]?.delta?.content || "";
            if (j.usage) {
              inT = j.usage.prompt_tokens ?? inT;
              outT = j.usage.completion_tokens ?? outT;
            }
          } catch {
            // Non-JSON keepalive — already forwarded.
          }
        }
      }
      if (!inT) inT = estimateTokens(messages.map((m) => m.content).join("\n"));
      if (!outT) outT = estimateTokens(content);
      return { content, inputTokens: inT, outputTokens: outT };
    } finally {
      clearTimeout(t);
    }
  }
}

export class MockProvider implements LLMProvider {
  name = "mock";
  async chat(messages: ChatMessage[], upstreamModel: string, opts?: ProviderCallOpts): Promise<ProviderResult> {
    const last = messages.filter((m) => m.role === "user").pop()?.content || "";
    const toolNote = opts?.tools ? ` Tools: ${Array.isArray(opts.tools) ? opts.tools.length : 1} definition(s) passed through.` : "";
    const content = `[mock:${upstreamModel}] I received ${last.length} chars. Set a real provider key to call an upstream model.${toolNote}`;
    return { content, inputTokens: estimateTokens(last), outputTokens: estimateTokens(content), upstreamModel };
  }
}
