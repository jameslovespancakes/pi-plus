import { configPath, resetConfigCache, updateConfig, type PiPlusConfig } from "../../../core/config.ts";
import { readJson } from "../../../core/store.ts";

/** Read through disk so existing sessions and workflow children agree. */
export function primaryAccountEnabled(providerId: string): boolean {
  const disabled = readJson<Partial<PiPlusConfig>>(configPath(), {})?.disabledPrimaryAccounts;
  return !Array.isArray(disabled) || !disabled.includes(providerId);
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
