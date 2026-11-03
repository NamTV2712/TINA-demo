/** Settings → Models catalog metadata.
 *
 *  The provider API is the source of truth for which models a credential can use; `ModelPicker`
 *  loads that live list through `/api/models/catalog`. The entries here are only the OFFLINE
 *  fallback shown before a key is saved (or when the provider cannot be reached), so the field is
 *  never an empty box while the provider is unreachable. **Custom model…** covers every ID these
 *  short lists do not carry.
 *
 *  Intelligence is a separate choice (Settings → Models → Intelligence) because it is a per-turn
 *  reasoning budget, not part of the model's name.
 */

export type ModelChoice = { id: string; label: string };

const GEMINI_FALLBACK: ModelChoice[] = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.8-pro", label: "Gemini 3.8 Pro" },
  { id: "gemini-3.8-flash-lite", label: "Gemini 3.8 Flash Lite" },
];

/** Fallback suggestions per provider mode. A missing key (or null) keeps the field as free text. */
export const MODEL_FALLBACKS: Record<string, ModelChoice[]> = {
  groq: [
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
    { id: "qwen/qwen3-32b", label: "Qwen3 32B" },
  ],
  deepseek: [
    { id: "deepseek-flash", label: "DeepSeek Flash" },
    { id: "deepseek-chat", label: "DeepSeek Chat" },
    { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
  ],
  gemini: GEMINI_FALLBACK,
  antigravity: GEMINI_FALLBACK,
  "openai-api": [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "gpt-5-nano", label: "GPT-5 nano" },
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "o3", label: "o3" },
  ],
  subscription: [
    { id: "sonnet", label: "Claude Sonnet" },
    { id: "opus", label: "Claude Opus" },
    { id: "haiku", label: "Claude Haiku" },
  ],
};

/** Providers whose model list can be fetched with the user's key. The ChatGPT plan has its own
 *  account-bound catalogue (`ChatGPTModelInput`); Bedrock/custom depend on the endpoint/region and
 *  stay free text. */
const LIVE_MODES = new Set(["groq", "deepseek", "gemini", "antigravity", "openai-api"]);

export function hasLiveCatalog(mode: string | undefined | null): boolean {
  return !!mode && LIVE_MODES.has(mode);
}

/** The offline suggestions for a provider mode, or null when the field must stay free text
 *  (deployment default, custom endpoint, Bedrock). */
export function fallbackChoicesForMode(mode: string | undefined | null): ModelChoice[] | null {
  if (!mode) return null;
  return MODEL_FALLBACKS[mode] ?? null;
}

/** The per-turn reasoning budget. Empty = the model/provider default; the value reaches the agent
 *  harness as its effort pin (the same `effort` pref the CLI used to expose as a raw enum). */
export type IntelligenceLevel = "" | "low" | "medium" | "high" | "xhigh";

export const INTELLIGENCE_OPTIONS: Array<{ value: IntelligenceLevel; label: string }> = [
  { value: "", label: "Auto — model default" },
  { value: "low", label: "Fast — minimal thinking" },
  { value: "medium", label: "Balanced — moderate thinking" },
  { value: "high", label: "Deep — more thinking" },
  { value: "xhigh", label: "Maximum — deepest thinking" },
];
