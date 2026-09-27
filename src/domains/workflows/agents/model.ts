import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface ResolvedAgentModelRequest {
  readonly ref: string;
  readonly provider: string;
  readonly id: string;
}

export interface ResolvedAgentModel {
  readonly model: Model<Api> | undefined;
  readonly requested: ResolvedAgentModelRequest | undefined;
}

/** Shared by session construction and child-only interactive model changes. */
export function resolveAgentModel(
  modelRef: string | undefined,
  modelRegistry: Pick<ModelRegistry, "find">,
  hostModel: Model<Api> | undefined,
): ResolvedAgentModel {
  if (modelRef === undefined) return { model: hostModel, requested: undefined };
  const parsed = parseAgentModelRef(modelRef);
  const found = modelRegistry.find(parsed.provider, parsed.id);
  if (!found) {
    throw new Error(`Agent model "${modelRef}" not found (resolved as ${parsed.provider}/${parsed.id}).`);
  }
  return { model: found, requested: parsed };
}

function parseAgentModelRef(modelRef: string): ResolvedAgentModelRequest {
  const normalized = modelRef.trim();
  if (normalized.length === 0) {
    throw new Error('Invalid agent model ref: expected a bare model id or "provider/id".');
  }
  if (normalized !== modelRef) {
    throw new Error(`Invalid agent model ref "${modelRef}": remove leading or trailing whitespace.`);
  }
  const slash = modelRef.indexOf("/");
  if (slash === -1) return { ref: modelRef, provider: "anthropic", id: modelRef };
  const provider = modelRef.slice(0, slash);
  const id = modelRef.slice(slash + 1);
  if (provider.length === 0 || id.length === 0 || id.startsWith("/")) {
    throw new Error(`Invalid agent model ref "${modelRef}": expected "provider/id".`);
  }
  return { ref: modelRef, provider, id };
}
