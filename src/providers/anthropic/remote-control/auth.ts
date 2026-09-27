import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Upstream used AuthStorage.getApiKey(). In current pi, ModelRuntime owns
 * that API and its locked OAuth refresh. Use an auth-only native runtime:
 * same auth.json, no catalog fetches, no inference or account-pool routing.
 * A Claude remote session must stay with the primary logged-in account.
 */
export function createTokenSource(
  create: () => Promise<Pick<ModelRuntime, "listCredentials" | "getAuth">> = () => ModelRuntime.create({
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  }),
) {
  let runtime: ReturnType<typeof create> | undefined;
  return async (signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    const auth = await (runtime ??= create());
    const credentials = await auth.listCredentials({ signal });
    if (!credentials.some((entry) => entry.providerId === "anthropic" && entry.type === "oauth")) {
      throw new Error("Anthropic OAuth login required");
    }
    const result = await auth.getAuth("anthropic", { signal });
    if (!result?.auth.apiKey || result.source !== "OAuth") throw new Error("Anthropic OAuth login required");
    return result.auth.apiKey;
  };
}
