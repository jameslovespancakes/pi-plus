import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";

function officialEndpoint(model: Model<Api>): boolean {
  try {
    const url = new URL(model.baseUrl);
    const path = model.api === "anthropic-messages" ? "/api" : "/api/v1";
    return url.origin === "https://openrouter.ai" && url.pathname.replace(/\/+$/, "") === path
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Enforce through pi's own routing support, without replacing its provider or tools. */
export function withOpenRouterZdr(model: Model<Api>, options?: StreamOptions) {
  if (!["openai-completions", "anthropic-messages"].includes(model.api) || !officialEndpoint(model)) {
    throw new Error("OpenRouter On (ZDR) cannot enforce this API or endpoint. Use pi's native OpenRouter Chat Completions or Messages route.");
  }
  const preferences = model.compat && "openRouterRouting" in model.compat ? model.compat.openRouterRouting : undefined;
  return {
    model: model.api === "openai-completions" ? {
      ...model,
      compat: {
        ...model.compat,
        openRouterRouting: { ...preferences, zdr: true },
      },
    } : model,
    options: {
      ...options,
      // Run caller instrumentation first, then enforce the final request's
      // privacy restriction. No retry without ZDR is allowed.
      onPayload: async (payload: unknown, requestModel: Model<Api>) => {
        const replacement = await options?.onPayload?.(payload, requestModel);
        const body = replacement === undefined ? payload : replacement;
        if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)
          || "input" in body || "instructions" in body) {
          throw new Error("OpenRouter On (ZDR) blocked an unsupported request payload.");
        }
        const routing = "provider" in body ? body.provider : undefined;
        // Pi natively serializes openRouterRouting on Chat Completions. Its
        // Anthropic adapter does not, although OpenRouter's Messages API accepts
        // the same provider preferences. Add only that missing request field.
        if (model.api === "anthropic-messages") {
          if (routing !== undefined && (!routing || typeof routing !== "object" || Array.isArray(routing))) {
            throw new Error("OpenRouter On (ZDR) blocked malformed provider preferences.");
          }
          return { ...body, provider: { ...preferences, ...routing, zdr: true } };
        }
        if (!routing || typeof routing !== "object" || !("zdr" in routing) || routing.zdr !== true) {
          throw new Error("OpenRouter On (ZDR) blocked a request without provider.zdr=true.");
        }
        return body;
      },
    },
  };
}
