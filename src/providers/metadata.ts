/** Package billing classifications, not a second model catalogue. Models still come from pi. */
const SUBSCRIPTION_PROVIDERS = new Set(["anthropic", "openai-codex", "gemini", "kimi-coding"]);

export function providerBilling(provider: string): "subscription" | "metered" {
  return SUBSCRIPTION_PROVIDERS.has(provider) ? "subscription" : "metered";
}
