import type { JevDecision, Tier } from "../types.js";
import { clampConfidence, type JevProvider } from "./types.js";

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

function toTier(choice: string): Tier {
  const v = choice.toLowerCase();
  if (v.includes("power")) return "powerful";
  if (v.includes("balanc")) return "balanced";
  return "fast";
}

// Native TypeSafe Decisions API. Expects JEV_TYPESAFE_API_KEY.
// Body shape follows TypeSafe docs: { state, questions: { route: {type:'choice', options:[...]} } }
export class TypeSafeJevProvider implements JevProvider {
  name = "typesafe";
  constructor(
    private apiKey = process.env.JEV_TYPESAFE_API_KEY || process.env.JEV_API_KEY || "",
    private url = process.env.JEV_TYPESAFE_URL || "https://api.typesafe.ai/v1/decisions",
    private model = process.env.JEV_TYPESAFE_MODEL || "jev-1",
    private timeoutMs = 800,
  ) {}

  async decide(state: string): Promise<JevDecision> {
    if (!this.apiKey) throw new Error("typesafe: missing JEV_TYPESAFE_API_KEY");
    const { signal, done } = withTimeout(this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          state,
          questions: {
            route: {
              type: "choice",
              options: ["fast", "balanced", "powerful"],
              instructions: "Which model capability tier does this request need?",
            },
            escalate: { type: "noul", instructions: "Does this need human review or the strongest tier?" },
          },
        }),
      });
      if (!res.ok) throw new Error(`typesafe status ${res.status}`);
      const json = (await res.json()) as {
        answers?: { route?: { value?: string; probabilities?: Record<string, number>; confidence?: number }; escalate?: { probability?: number } };
      };
      const route = json.answers?.route;
      const tier = toTier(route?.value || "balanced");
      return {
        tier,
        confidence: clampConfidence(route?.confidence ?? 0.75),
        probabilities: route?.probabilities,
        escalation: (json.answers?.escalate?.probability ?? 0) > 0.5,
      };
    } finally {
      done();
    }
  }
}
