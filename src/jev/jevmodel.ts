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

// Hosted Jev decision API at jevmodel.org (see https://jevmodel.org/docs/).
// Same SystemOne wire shape: POST /v1/systemone with Bearer key,
// { state, model, questions }; Choice answers { choice, confidence, probabilities }.
export class JevModelProvider implements JevProvider {
  name = "jevmodel";
  constructor(
    private apiKey = process.env.JEVMODEL_API_KEY || process.env.JEV_API_KEY || "",
    private url = process.env.JEVMODEL_URL || "https://jevmodel.org/v1/systemone",
    private model = process.env.JEVMODEL_MODEL || "jev-latest",
    private timeoutMs = 800,
  ) {}

  async decide(state: string): Promise<JevDecision> {
    if (!this.apiKey) throw new Error("jevmodel: missing JEVMODEL_API_KEY");
    const { signal, done } = withTimeout(this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          state: state.slice(0, 8000),
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
      if (res.status === 402) throw new Error("jevmodel: insufficient credits (402)");
      if (!res.ok) throw new Error(`jevmodel status ${res.status}`);
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
