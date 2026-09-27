import type { ChatMessage, ProviderResult } from "../types.js";

export interface LLMProvider {
  name: string;
  chat(messages: ChatMessage[], upstreamModel: string, opts: ProviderCallOpts): Promise<ProviderResult>;
}

export type ProviderCallOpts = {
  maxTokens?: number;
  temperature?: number;
  timeoutMs: number;
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
};

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}
