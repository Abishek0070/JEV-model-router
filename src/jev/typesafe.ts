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

// Native TypeSafe Decisions API (see https://docs.typesafe.ai/introduction/quickstart).
// POST {url} with { state, model, questions }; Choice uses a `criteria`
// dict and answers with `{ choice, confidence, probabilities }`.
export class TypeSafeJevProvider implements JevProvider {
  name = "typesafe";
  constructor(
    private apiKey = process.env.JEV_TYPESAFE_API_KEY || process.env.JEV_API_KEY || "",
    private url = process.env.JEV_TYPESAFE_URL || "https://api.typesafe.ai/v1/systemone",
    private model = process.env.JEV_TYPESAFE_MODEL || "jev-latest",
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
          state,
          model: this.model,
          questions: {
            route: {
              type: "choice",
              instructions: "Which model capability tier does this request need?",
              criteria: {
                fast: "Simple, low-stakes request a small fast model handles",
                balanced: "Everyday engineering task needing a capable mid-tier model",
                powerful: "Hard reasoning, production incident, or high-stakes task needing the strongest model",
              },
            },
            escalate: { type: "noul", instructions: "This needs human review or the strongest tier" },
          },
        }),
      });
      if (!res.ok) throw new Error(`typesafe status ${res.status}`);
      const json = (await res.json()) as {
        answers?: {
          route?: { choice?: string; probabilities?: Record<string, number>; confidence?: number };
          escalate?: { noul?: number };
        };
      };
      const route = json.answers?.route;
      const tier = toTier(route?.choice || "balanced");
      return {
        tier,
        confidence: clampConfidence(route?.confidence ?? 0.75),
        probabilities: route?.probabilities,
        escalation: (json.answers?.escalate?.noul ?? 0) > 0.5,
      };
    } finally {
      done();
    }
  }
}
