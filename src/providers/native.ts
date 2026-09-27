import type { ChatMessage, ProviderResult } from "../types.js";
import { estimateTokens, fetchWithTimeout, type LLMProvider, type ProviderCallOpts } from "./base.js";

// Minimal Anthropic Messages translation.
// NOTE: OpenAI-style `tools` are stripped for Anthropic/Gemini targets in v0.2
// (shapes differ); the router logs a warning. Use an OpenAI-compatible
// provider when tool calling must reach the model.
export class AnthropicProvider implements LLMProvider {
  name = "anthropic";
  constructor(private apiKey = process.env.ANTHROPIC_API_KEY || "") {}
  async chat(messages: ChatMessage[], upstreamModel: string, opts: ProviderCallOpts): Promise<ProviderResult> {
    if (!this.apiKey) throw Object.assign(new Error("anthropic: missing ANTHROPIC_API_KEY"), { status: 401 });
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const body: Record<string, unknown> = {
      model: upstreamModel,
      max_tokens: opts.maxTokens ?? 512,
      temperature: opts.temperature ?? 0.7,
      system: system || undefined,
      messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    };
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    }, opts.timeoutMs);
    if (!res.ok) throw Object.assign(new Error(`anthropic status ${res.status}`), { status: res.status });
    const json = (await res.json()) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    const content = json.content?.map((c) => c.text || "").join("") || "";
    return {
      content,
      inputTokens: json.usage?.input_tokens ?? estimateTokens(messages.map((m) => m.content).join("\n")),
      outputTokens: json.usage?.output_tokens ?? estimateTokens(content),
      upstreamModel,
    };
  }
}

// Minimal Gemini generateContent translation.
export class GeminiProvider implements LLMProvider {
  name = "gemini";
  constructor(private apiKey = process.env.GEMINI_API_KEY || "") {}
  async chat(messages: ChatMessage[], upstreamModel: string, opts: ProviderCallOpts): Promise<ProviderResult> {
    if (!this.apiKey) throw Object.assign(new Error("gemini: missing GEMINI_API_KEY"), { status: 401 });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${upstreamModel}:generateContent?key=${this.apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        systemInstruction: messages.some((m) => m.role === "system") ? { parts: [{ text: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") }] } : undefined,
        generationConfig: { maxOutputTokens: opts.maxTokens ?? 512, temperature: opts.temperature ?? 0.7 },
      }),
    }, opts.timeoutMs);
    if (!res.ok) throw Object.assign(new Error(`gemini status ${res.status}`), { status: res.status });
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    const content = json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    return {
      content,
      inputTokens: json.usageMetadata?.promptTokenCount ?? estimateTokens(messages.map((m) => m.content).join("\n")),
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? estimateTokens(content),
      upstreamModel,
    };
  }
}
