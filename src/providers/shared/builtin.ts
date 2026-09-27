import type { Api, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/**
 * One of pi's own providers, from the host's copy of pi-ai.
 *
 * pi hands extensions its pi-ai through a fixed set of entry points (the
 * package root, `compat`, `oauth` and `providers/all`) and installs packages
 * without their peers. A deep import such as `pi-ai/providers/openai-codex`
 * therefore has no copy to resolve against on a clean install, and wherever a
 * stray copy does exist it is a different version from the host — the exact
 * way stale provider definitions have dropped tools before.
 * `providers/all` is always the host's, so providers come from here.
 */
export function builtinProvider<TApi extends Api>(id: string): Provider<TApi> {
  const provider = builtinProviders().find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`This version of pi has no built-in "${id}" provider.`);
  return provider as unknown as Provider<TApi>;
}
