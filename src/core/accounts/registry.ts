/** Provider-agnostic subscription account adapters. */

export interface ManagedAccount {
  id: string;
  label: string;
  /** False when the account is configured but deliberately skipped. */
  enabled: boolean;
  /** OAuth expiry, when the provider exposes one. */
  expiresAt?: number;
  /** True for the account pi itself is authenticated as. */
  primary?: boolean;
}

/** `standard` prefers primary auth; `optimal` enables provider pooling. */
export type RoutingMode = "standard" | "optimal";

export interface AccountUi {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface AccountContext {
  ui: AccountUi;
  hasUI: boolean;
  signal?: AbortSignal;
  /** Opens an OAuth URL. */
  openBrowser(url: string): Promise<void>;
}

export interface RoutingSupport {
  get(): Promise<RoutingMode>;
  set(mode: RoutingMode): Promise<RoutingMode>;
  describe(mode: RoutingMode): string;
}

export interface AccountProvider {
  /** Matches the pi provider id, e.g. "anthropic". */
  id: string;
  /** Human name, e.g. "Claude". */
  label: string;
  list(): Promise<ManagedAccount[]>;
  /** Returns the label of the account that was added. */
  add(ctx: AccountContext, label: string): Promise<string | undefined>;
  /** Returns the label of the account that was reauthorized. */
  reauth(ctx: AccountContext, accountId: string): Promise<string | undefined>;
  /** Enables or disables an account without removing credentials. */
  setEnabled?(accountId: string, enabled: boolean): Promise<void>;
  /** Changes only the display label. */
  rename?(accountId: string, label: string): Promise<void>;
  routing?: RoutingSupport;
}

const providers = new Map<string, AccountProvider>();

export function registerAccountProvider(provider: AccountProvider): void {
  providers.set(provider.id, provider);
}

export function accountProviders(): AccountProvider[] {
  return [...providers.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function accountProvider(id: string): AccountProvider | undefined {
  return providers.get(id.toLowerCase());
}

/** Providers that can balance across more than one account. */
export function routableProviders(): AccountProvider[] {
  return accountProviders().filter((provider) => provider.routing !== undefined);
}

export function resetAccountProviders(): void {
  providers.clear();
}
