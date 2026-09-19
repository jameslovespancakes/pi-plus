import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCatalogTool } from "./catalog-tool.ts";
import { registerPolicyGate } from "./policy-gate.ts";

/**
 * Models domain: which models exist, how good they are, and what they cost.
 *
 * Combines the old `model-catalog.ts` and `model-policy-gate.ts`: the catalogue
 * ranks models and the gate decides whether a given one is allowed to bill.
 */
export default function models(pi: ExtensionAPI) {
  registerCatalogTool(pi);
  registerPolicyGate(pi);
}
