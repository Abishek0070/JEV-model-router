import type { JevDecision, Tier } from "../types.js";
import { clampConfidence, type JevProvider } from "./types.js";

// Heuristic local provider for dev/offline. No network, no cost.
// Rule order matters: escalation signals -> powerful, code/reasoning -> balanced/powerful.
export class LocalJevProvider implements JevProvider {
  name = "local";
  async decide(state: string): Promise<JevDecision> {
    const s = state.toLowerCase();
    const len = state.length;

    const escalate = /production down|prod.*500|data loss|delete.*prod|security breach|p0|sev1/i.test(state);
    const hard = /prove|theorem|formal verification|distributed consensus|multi-region|byzantine|zero downtime.*correctness/i.test(state);
    const medium = /debug|error|stack trace|crashloop|oomkilled|sql|kubernetes|docker|refactor|api design|duplicate|security.*review|review.*dockerfile/i.test(state);
    const trivial = /^(hi|hello|hey|thanks|ok)\b/.test(s) || len < 60;

    let tier: Tier = "balanced";
    let confidence = 0.72;
    if (escalate || hard || len > 2500) {
      tier = "powerful";
      confidence = escalate ? 0.88 : 0.81;
    } else if (medium || len >= 200) {
      tier = "balanced";
      confidence = 0.76;
    } else if (trivial || len < 200) {
      tier = "fast";
      confidence = 0.78;
    }

    const probs: Record<string, number> =
      tier === "fast"
        ? { fast: 0.7, balanced: 0.22, powerful: 0.08 }
        : tier === "balanced"
          ? { fast: 0.18, balanced: 0.64, powerful: 0.18 }
          : { fast: 0.06, balanced: 0.24, powerful: 0.7 };

    const decision: JevDecision = {
      tier,
      confidence: clampConfidence(confidence),
      probabilities: probs,
      escalation: escalate,
    };
    return decision;
  }
}
