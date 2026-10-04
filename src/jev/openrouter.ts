import type { JevDecision } from "../types.js";
import { clampConfidence, withTimeout, type JevProvider } from "./types.js";

// Jev via OpenRouter (hosts typesafe/jev snapshots). Best-effort adapter:
// asks for strict JSON {tier, confidence} and parses it.
export class OpenRouterJevProvider implements JevProvider {
  name = "openrouter";
  constructor(
    private apiKey = process.env.OPENROUTER_API_KEY || "",
    private baseUrl = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    private model = process.env.OPENROUTER_JEV_MODEL || "typesafe/jev-1",
    private timeoutMs = 800,
  ) {}

  async decide(state: string): Promise<JevDecision> {
    if (!this.apiKey) throw new Error("openrouter: missing OPENROUTER_API_KEY");
    const { signal, done } = withTimeout(this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: 'Return ONLY JSON: {"tier":"fast|balanced|powerful","confidence":0-1}' },
            { role: "user", content: state.slice(0, 4000) },
          ],
          temperature: 0,
          max_tokens: 60,
        }),
      });
      if (!res.ok) throw new Error(`openrouter status ${res.status}`);
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content || "{}";
      const m = text.match(/\{[^}]*\}/);
      const parsed = JSON.parse(m ? m[0] : "{}") as { tier?: string; confidence?: number };
      const tier = parsed.tier === "fast" || parsed.tier === "powerful" ? parsed.tier : "balanced";
      return { tier, confidence: clampConfidence(Number(parsed.confidence ?? 0.7)) };
    } finally {
      done();
    }
  }
}
