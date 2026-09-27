import type { AppConfig, JevDecision } from "../types.js";
import { LocalJevProvider } from "./local.js";
import { OpenRouterJevProvider } from "./openrouter.js";
import { TypeSafeJevProvider } from "./typesafe.js";
import type { JevProvider } from "./types.js";

type Breaker = { fails: number; openUntil: number };

// Tries jev.order providers in sequence with timeout + circuit breaker.
// Local mock is always registered so dev works with zero keys.
export class JevRouter {
  private providers: Map<string, JevProvider>;
  private breakers = new Map<string, Breaker>();

  constructor(private cfg: AppConfig) {
    const timeout = cfg.jev.timeoutMs;
    this.providers = new Map<string, JevProvider>([
      ["typesafe", new TypeSafeJevProvider(process.env.JEV_TYPESAFE_API_KEY || process.env.JEV_API_KEY, process.env.JEV_TYPESAFE_URL, process.env.JEV_TYPESAFE_MODEL, timeout)],
      ["openrouter", new OpenRouterJevProvider(process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_BASE_URL, process.env.OPENROUTER_JEV_MODEL, timeout)],
      ["local", new LocalJevProvider()],
    ]);
  }

  private breakerOpen(name: string): boolean {
    const b = this.breakers.get(name);
    return !!b && Date.now() < b.openUntil;
  }

  private recordFail(name: string): void {
    const b = this.breakers.get(name) || { fails: 0, openUntil: 0 };
    b.fails += 1;
    if (b.fails >= this.cfg.jev.breaker.tripAfterFails) {
      b.openUntil = Date.now() + this.cfg.jev.breaker.cooldownMs;
      b.fails = 0;
    }
    this.breakers.set(name, b);
  }

  async decide(state: string): Promise<{ decision: JevDecision; providerUsed: string; latencyMs: number }> {
    const t0 = performance.now();
    let lastErr: unknown = null;
    for (const name of this.cfg.jev.order) {
      const p = this.providers.get(name);
      if (!p || this.breakerOpen(name)) continue;
      try {
        const d = await p.decide(state);
        return { decision: d, providerUsed: name, latencyMs: performance.now() - t0 };
      } catch (e) {
        lastErr = e;
        this.recordFail(name);
      }
    }
    // Guaranteed fallback: local never requires keys.
    const fallback = new LocalJevProvider();
    const d = await fallback.decide(state);
    void lastErr;
    return { decision: d, providerUsed: "local", latencyMs: performance.now() - t0 };
  }
}
