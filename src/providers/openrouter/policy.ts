import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";

function officialEndpoint(model: Model<Api>): boolean {
  try {
    const url = new URL(model.baseUrl);
    const path = model.api === "anthropic-messages" ? "/api" : "/api/v1";
    return url.origin === "https://openrouter.ai" && url.pathname.replace(/\/+$/, "") === path
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Translate only OpenRouter's privacy-routing 404; retain status for pi's retry handling. */
async function explainUnavailableZdr(response: Response): Promise<Response> {
  if (response.status !== 404) return response;
  try {
    const body = await response.clone().json();
    if (typeof body?.error?.message !== "string"
      || !/no endpoints found.*(?:data policy|\bzdr\b|zero.data.retention)/i.test(body.error.message)) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json");
    return Response.json({
      ...body,
      error: { ...body.error, message: "No ZDR endpoint is available for this model. Choose another model to keep ZDR enabled." },
    }, { status: response.status, statusText: response.statusText, headers });
  } catch { return response; } // Unknown error formats remain pi's responsibility.
}

/** Enforce through pi's own routing support, without replacing its provider or tools. */
export function withOpenRouterZdr(model: Model<Api>, options?: StreamOptions) {
  if (!["openai-completions", "anthropic-messages"].includes(model.api) || !officialEndpoint(model)) {
    throw new Error("OpenRouter ZDR can't be enforced on this connection. Choose a standard OpenRouter model.");
  }
  const preferences = model.compat && "openRouterRouting" in model.compat ? model.compat.openRouterRouting : undefined;
  const fetch = options?.fetch ?? globalThis.fetch;
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
      fetch: async (...args: Parameters<typeof fetch>) => explainUnavailableZdr(await fetch(...args)),
      // Run caller instrumentation first, then enforce the final request's
      // privacy restriction. No retry without ZDR is allowed.
      onPayload: async (payload: unknown, requestModel: Model<Api>) => {
        const replacement = await options?.onPayload?.(payload, requestModel);
        const body = replacement === undefined ? payload : replacement;
        if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)
          || "input" in body || "instructions" in body) {
          throw new Error("OpenRouter ZDR couldn't verify this request. Nothing was sent.");
        }
        const routing = "provider" in body ? body.provider : undefined;
        // Pi natively serializes openRouterRouting on Chat Completions. Its
        // Anthropic adapter does not, although OpenRouter's Messages API accepts
        // the same provider preferences. Add only that missing request field.
        if (model.api === "anthropic-messages") {
          if (routing !== undefined && (!routing || typeof routing !== "object" || Array.isArray(routing))) {
            throw new Error("OpenRouter ZDR couldn't verify the routing settings. Nothing was sent.");
          }
          return { ...body, provider: { ...preferences, ...routing, zdr: true } };
        }
        if (!routing || typeof routing !== "object" || !("zdr" in routing) || routing.zdr !== true) {
          throw new Error("OpenRouter ZDR was removed from this request. Nothing was sent.");
        }
        return body;
      },
    },
  };
}
