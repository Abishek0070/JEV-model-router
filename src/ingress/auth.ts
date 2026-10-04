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

// Minimal in-memory quota: 60 req/min per key (or per IP when open).
const hits = new Map<string, number[]>();

export function checkQuota(id: string): boolean {
  const now = Date.now();
  const arr = (hits.get(id) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(id, arr);
  return arr.length <= 60;
}
