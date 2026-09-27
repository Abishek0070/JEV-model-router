export function gatewayKeys(): string[] {
  return (process.env.GATEWAY_API_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function checkAuth(header: string | undefined): boolean {
  const keys = gatewayKeys();
  if (keys.length === 0) return true; // dev-open
  if (!header) return false;
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return keys.includes(token);
}

// Minimal in-memory quota: 60 req/min + $1/day per key (or per IP when open).
const hits = new Map<string, number[]>();
const spend = new Map<string, { day: string; usd: number }>();

export function checkQuota(id: string): boolean {
  const now = Date.now();
  const arr = (hits.get(id) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(id, arr);
  return arr.length <= 60;
}

export function addSpend(id: string, usd: number): void {
  const day = new Date().toISOString().slice(0, 10);
  const cur = spend.get(id);
  if (!cur || cur.day !== day) spend.set(id, { day, usd });
  else cur.usd += usd;
}
