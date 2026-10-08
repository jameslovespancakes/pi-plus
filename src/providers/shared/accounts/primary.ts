import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configPath, resetConfigCache, updateConfig, type PiPlusConfig } from "../../../core/config.ts";
import { readJson } from "../../../core/store.ts";

/** Read through disk so existing sessions and workflow children agree. */
export function primaryAccountEnabled(providerId: string): boolean {
  const disabled = readJson<Partial<PiPlusConfig>>(configPath(), {})?.disabledPrimaryAccounts;
  return !Array.isArray(disabled) || !disabled.includes(providerId);
}

/**
 * Replaces pi's primary login with a fresh credential. pi owns auth.json, so
 * this goes through pi's own login path (the same locked write as `/login`)
 * using an auth-only runtime, as Remote Control does.
 */
export async function savePrimaryLogin(provider: Provider, credential: OAuthCredential): Promise<void> {
  const oauth = provider.auth.oauth;
  if (!oauth) throw new Error(`${provider.name} has no subscription login.`);
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, oauth: { ...oauth, login: async () => credential } } });
  try {
    await runtime.login(provider.id, "oauth", { prompt: async () => { throw new Error("Login already completed."); }, notify() {} });
  } catch (error) {
    // Saved; only this throwaway runtime's model snapshot failed to update.
    if (!(error instanceof CredentialSynchronizationError)) throw error;
  }
}

/** No credential copying, logout, or token rotation just to change eligibility. */
export function setPrimaryAccountEnabled(providerId: string, enabled: boolean): void {
  resetConfigCache();
  const saved = updateConfig((config) => {
    const disabled = new Set(config.disabledPrimaryAccounts ?? []);
    if (enabled) disabled.delete(providerId);
    else disabled.add(providerId);
    if (disabled.size) config.disabledPrimaryAccounts = [...disabled];
    else delete config.disabledPrimaryAccounts;
  });
  if (!saved) {
    resetConfigCache();
    throw new Error("Could not save primary account setting.");
  }
}
