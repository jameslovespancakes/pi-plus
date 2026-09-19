import type { Component } from "@earendil-works/pi-tui";
import { hasTruecolor, levelColor } from "../../ui/format.ts";
import type { AccountProvider, ManagedAccount } from "../../core/accounts/registry.ts";

/**
 * The `/accounts` list.
 *
 * Mirrors the provider picker: an inline SettingsList inside pi's own rule
 * chrome, toggled in place so nothing redraws the screen. Rows are grouped by
 * provider, because an account label alone ("Personal") does not say which
 * subscription it belongs to.
 */

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
  detail?: string;
}

/** Flattens every provider's accounts into one ordered list. */
export async function accountRows(providers: AccountProvider[]): Promise<AccountRow[]> {
  const rows: AccountRow[] = [];
  for (const provider of providers) {
    let accounts: ManagedAccount[] = [];
    try {
      accounts = await provider.list();
    } catch {
      continue; // A provider that cannot enumerate is simply not shown.
    }
    for (const account of accounts) {
      rows.push({
        id: `${provider.id}:${account.id}`,
        providerId: provider.id,
        providerLabel: provider.label,
        label: account.label,
        state: account.enabled ? "enabled" : "disabled",
        detail: account.primary ? "primary" : undefined,
      });
    }
  }
  return rows;
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

/**
 * What closing the picker asked for.
 *
 * The wizards run AFTER the picker closes rather than inside it, so they can
 * use pi's ordinary select/input prompts instead of being reimplemented as
 * nested TUI components.
 */
export type PickerAction = { kind: "add" } | { kind: "rename" } | undefined;

/** Action row ids are namespaced so they cannot collide with an account id. */
const ADD_ID = "__action_add";
const RENAME_ID = "__action_rename";

export interface AccountPickerDeps {
  rows: () => Promise<AccountRow[]>;
  /** Applies a toggle and returns the resulting state. Synchronous so the
   *  label, dot and value all change in one render. */
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
      values: [...toggleValues],
      currentValue: colourAccountState(theme, row.state),
      description: row.detail,
    }));

    // Actions live as rows rather than hidden keystrokes, so they are
    // discoverable. A single-entry `values` makes Enter fire onChange without
    // the row appearing to cycle through anything.
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
