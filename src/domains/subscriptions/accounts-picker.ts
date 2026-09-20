import type { Component } from "@earendil-works/pi-tui";
import { hasTruecolor, levelColor } from "../../ui/format.ts";
import type { AccountProvider, ManagedAccount } from "../../core/accounts/registry.ts";

/** Inline account picker grouped by provider. */

export type AccountState = "enabled" | "disabled";

export const ACCOUNT_STATE_TEXT: Record<AccountState, string> = {
  enabled: "Enabled",
  disabled: "Disabled",
};

/** Enabled reads as a full quota bar, disabled as an empty one. */
const STATE_LEVEL: Record<AccountState, number> = { enabled: 100, disabled: 0 };
const STATE_THEME: Record<AccountState, string> = { enabled: "success", disabled: "muted" };

export function colourAccountState(theme: any, state: AccountState, text: string = ACCOUNT_STATE_TEXT[state]): string {
  if (hasTruecolor()) return levelColor(STATE_LEVEL[state])(text);
  return theme.fg(STATE_THEME[state], text);
}

export interface AccountRow {
  id: string;
  providerId: string;
  providerLabel: string;
  label: string;
  state: AccountState;
  primary?: boolean;
  detail?: string;
}

export type PrimaryAccountResolver = (
  provider: AccountProvider,
) => ManagedAccount | undefined | Promise<ManagedAccount | undefined>;

/** Adds pi's own credential to a provider's sidecar-managed accounts. */
export async function providerAccounts(
  provider: AccountProvider,
  resolvePrimary?: PrimaryAccountResolver,
): Promise<ManagedAccount[]> {
  // Resolve serially so providers that discover identity through a profile
  // endpoint do not burst the same endpoint for primary and sidecar accounts.
  const primary = resolvePrimary
    ? await Promise.resolve().then(() => resolvePrimary(provider)).catch(() => undefined)
    : undefined;
  const accounts = await provider.list();
  const combined = !primary || accounts.some((account) => account.primary || account.id === primary.id)
    ? accounts
    : [primary, ...accounts];

  const ids = new Set<string>();
  const identities = new Set<string>();
  return combined.filter((account) => {
    if (ids.has(account.id)) return false;
    ids.add(account.id);
    if (!account.identity) return true;
    if (identities.has(account.identity)) return false;
    identities.add(account.identity);
    return true;
  });
}

/** Flattens provider accounts while loading providers in parallel. */
export async function accountRows(
  providers: AccountProvider[],
  resolvePrimary?: PrimaryAccountResolver,
): Promise<AccountRow[]> {
  const groups = await Promise.all(providers.map(async (provider) => {
    let accounts: ManagedAccount[];
    try {
      accounts = await providerAccounts(provider, resolvePrimary);
    } catch {
      return [];
    }
    return accounts.map((account) => ({
      id: `${provider.id}:${account.id}`,
      providerId: provider.id,
      providerLabel: provider.label,
      label: account.label,
      state: account.enabled ? "enabled" as const : "disabled" as const,
      primary: account.primary,
      detail: account.primary ? "primary · managed by pi auth" : undefined,
    }));
  }));
  return groups.flat();
}

function labelFor(theme: any, row: AccountRow): string {
  const dot = colourAccountState(theme, row.state, "●");
  const name = row.state === "disabled" ? theme.fg("muted", row.label) : row.label;
  return `${dot} ${theme.fg("dim", row.providerLabel)}  ${name}`;
}

function framed(theme: any, list: any, title: string): Component {
  const rule = (w: number) => theme.fg("accent", "─".repeat(Math.max(1, w)));
  return {
    invalidate: () => list.invalidate?.(),
    handleInput: (data: string) => list.handleInput(data),
    handleMouse: (event: any) => list.handleMouse?.(event),
    render(width: number): string[] {
      const inner = Math.max(1, width);
      return [rule(inner), ` ${theme.fg("accent", theme.bold(title))}`, ...list.render(inner), rule(inner)];
    },
  } as Component;
}

/** Wizard requested when the picker closes. */
export type PickerAction = { kind: "add" } | { kind: "rename" } | undefined;

/** Action row ids are namespaced so they cannot collide with an account id. */
const ADD_ID = "__action_add";
const RENAME_ID = "__action_rename";

export interface AccountPickerDeps {
  rows: () => Promise<AccountRow[]>;
  /** Applies a toggle synchronously for one-render updates. */
  toggle: (providerId: string, accountId: string) => AccountState;
}

export async function openAccountsPicker(ctx: any, deps: AccountPickerDeps): Promise<PickerAction> {
  const rows = await deps.rows();

  const { SettingsList } = await import("@earendil-works/pi-tui");

  return await ctx.ui.custom((_tui: any, theme: any, _keys: any, done: (value?: unknown) => void) => {
    const toggleValues = [
      colourAccountState(theme, "enabled"),
      colourAccountState(theme, "disabled"),
    ];

    const items: any[] = rows.map((row) => ({
      id: row.id,
      label: labelFor(theme, row),
      values: row.primary ? [colourAccountState(theme, row.state)] : [...toggleValues],
      currentValue: colourAccountState(theme, row.state),
      description: row.detail,
    }));

    // Single-value action rows trigger onChange without cycling.
    items.push({
      id: ADD_ID,
      label: theme.fg("accent", "+ Add account"),
      values: [""],
      currentValue: "",
      description: "Authorize another subscription",
    });
    if (rows.length > 0) {
      items.push({
        id: RENAME_ID,
        label: theme.fg("accent", "✎ Rename account"),
        values: [""],
        currentValue: "",
        description: "Change an account's display name",
      });
    }

    let list: any;

    const onChange = (id: string) => {
      if (id === ADD_ID) { done({ kind: "add" }); return; }
      if (id === RENAME_ID) { done({ kind: "rename" }); return; }

      const row = rows.find((r) => r.id === id);
      const item = items.find((i) => i.id === id);
      if (!row || !item) return;
      if (row.primary) {
        ctx.ui.notify("Primary accounts are managed by pi auth.", "info");
        return;
      }
      try {
        const next = deps.toggle(row.providerId, row.id.slice(row.providerId.length + 1));
        row.state = next;
        item.label = labelFor(theme, row);
        list?.updateValue(id, colourAccountState(theme, next));
        list?.invalidate?.();
      } catch (error) {
        list?.updateValue(id, colourAccountState(theme, row.state));
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };

    list = new SettingsList(
      items,
      Math.min(items.length, 12),
      {
        label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
        value: (text: string) => text,
        description: (text: string) => theme.fg("dim", text),
        cursor: theme.fg("accent", "›"),
        hint: (text: string) => theme.fg("dim", text),
      },
      onChange,
      () => done(undefined),
    );

    return framed(theme, list, "Accounts") as Component & { dispose?(): void };
  });
}
