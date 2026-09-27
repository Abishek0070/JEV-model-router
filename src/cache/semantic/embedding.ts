// Optional semantic-cache module. Disabled by default in v0.1.
// Enable via cache.semantic.enabled=true without changing core routing.

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    // Tiny hashed bag-of-words embedding (no external API, no cost).
    const dim = 128;
    const vec = new Array<number>(dim).fill(0);
    for (const tok of text.toLowerCase().split(/\W+/)) {
      if (!tok) continue;
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      vec[h % dim] += 1;
    }
    const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(private apiKey: string, private model = "text-embedding-3-small") {}
  async embed(text: string): Promise<number[]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`embedding failed: ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data[0].embedding;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return dot;
}
