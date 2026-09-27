/**
 * Pooled providers with no usage endpoint, and the group their header-observed
 * rate-limit reading is filed under. Their bars can only show what responses said.
 */
export const OBSERVED_PROVIDERS: ReadonlyArray<readonly [providerId: string, group: string]> = [
  ["kimi-coding", "Kimi"],
  ["xai", "Grok"],
];
