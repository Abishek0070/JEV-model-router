import { AnthropicProvider, GeminiProvider } from "./native.js";
import { MockProvider, OpenAICompatibleProvider } from "./openaiCompatible.js";
import type { LLMProvider } from "./base.js";

export function buildProviders(): Map<string, LLMProvider> {
  const m = new Map<string, LLMProvider>();
  m.set("openai", new OpenAICompatibleProvider("openai", "https://api.openai.com/v1", process.env.OPENAI_API_KEY || ""));
  m.set("groq", new OpenAICompatibleProvider("groq", "https://api.groq.com/openai/v1", process.env.GROQ_API_KEY || ""));
  m.set("ollama", new OpenAICompatibleProvider("ollama", process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1", ""));
  m.set("anthropic", new AnthropicProvider());
  m.set("gemini", new GeminiProvider());
  m.set("mock", new MockProvider());
  return m;
}
