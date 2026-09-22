import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  accountRows,
  openAccountsPicker,
  providerAccounts,
  type AccountState,
} from "./accounts-picker.ts";
import {
  accountProvider,
  accountProviders,
  type AccountContext,
  type AccountProvider,
  type ManagedAccount,
} from "../../core/accounts/registry.ts";

/**
 * `/accounts` is provider-agnostic subscription account management.
 *
 *   /accounts          every provider's accounts, toggled enabled/disabled
 *   /accounts add      pick a provider, name the account, authorize
 *   /accounts reauth   reauthorize an existing account
 *
 * No provider-specific logic lives here; adapters are registered in
 * core/accounts/registry.ts, so a new provider is an adapter rather than a
 * new command.
 */

async function openBrowser(pi: ExtensionAPI, url: string): Promise<void> {
  if (process.platform === "win32") {
    await pi.exec("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
    return;
  }
  if (process.platform === "darwin") {
    await pi.exec("open", [url]);
    return;
  }
  await pi.exec("xdg-open", [url]);
}

function bridge(pi: ExtensionAPI, ctx: any): AccountContext {
  return {
    hasUI: ctx.hasUI,
    signal: ctx.signal,
    ui: {
      input: (title, placeholder, options) => ctx.ui.input(title, placeholder, options),
      select: (title, options, dialog) => ctx.ui.select(title, options, dialog),
      confirm: (title, message) => ctx.ui.confirm(title, message),
      notify: (message, type) => ctx.ui.notify(message, type ?? "info"),
    },
    openBrowser: (url) => openBrowser(pi, url),
  };
}

async function primaryAccount(provider: AccountProvider): Promise<ManagedAccount | undefined> {
  try {
    const credential = readStoredCredential(provider.id);
    if (!credential) return undefined;
    return {
      id: "main",
      label: "Primary",
      enabled: true,
      expiresAt: credential.type === "oauth" ? credential.expires : undefined,
      primary: true,
      identity: credential.type === "oauth" ? await provider.identify?.(credential.access) : undefined,
    };
  } catch {
    // A malformed/unreadable auth file must not hide the sidecar accounts.
    return undefined;
  }
}

function describe(account: ManagedAccount): string {
  const state = !account.enabled
    ? "disabled"
    : account.expiresAt !== undefined && account.expiresAt < Date.now() ? "expired" : "active";
  return `${account.label.padEnd(20)} ${state}${account.primary ? " · primary" : ""}`;
}

async function listAll(ctx: any): Promise<void> {
  const providers = accountProviders();
  if (providers.length === 0) {
    ctx.ui.notify("No account providers are registered.", "warning");
    return;
  }

  const blocks = await Promise.all(providers.map(async (provider): Promise<string[]> => {
    try {
      const [accounts, mode] = await Promise.all([
        providerAccounts(provider, primaryAccount),
        provider.routing?.get(),
      ]);
      const routing = mode ? ` · routing: ${mode}` : "";
      return [
        `${provider.label} (${provider.id})${routing}`,
        ...(accounts.length > 0
          ? accounts.map((account) => `  ${describe(account)}`)
          : [`  no additional accounts, add one with /accounts add ${provider.id}`]),
      ];
    } catch (error) {
      return [`${provider.label} (${provider.id}): ${error instanceof Error ? error.message : String(error)}`];
    }
  }));
  ctx.ui.notify(blocks.flat().join("\n"), "info");
}

async function pickAccount(ctx: any, provider: AccountProvider): Promise<string | undefined> {
  const accounts = (await provider.list()).filter((account) => !account.primary);
  if (accounts.length === 0) {
    ctx.ui.notify(`No ${provider.label} accounts yet. Add one with /accounts add ${provider.id}.`, "info");
    return undefined;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(`Choose an account with /accounts reauth ${provider.id}.`, "warning");
    return undefined;
  }

  const labels = accounts.map(describe);
  const choice = await ctx.ui.select(`Reauthorize which ${provider.label} account?`, labels);
  if (!choice) return undefined;
  return accounts[labels.indexOf(choice)]?.id;
}

export function registerAccountCommands(pi: ExtensionAPI): void {
  const toggle = (providerId: string, accountId: string): AccountState => {
    const provider = accountProvider(providerId);
    if (!provider?.setEnabled) throw new Error(`${providerId} accounts cannot be disabled.`);
    const next = pendingState.get(`${providerId}:${accountId}`) === "enabled" ? "disabled" : "enabled";
    pendingState.set(`${providerId}:${accountId}`, next);
    void provider.setEnabled(accountId, next === "enabled").catch(() => {});
    return next;
  };

  const pendingState = new Map<string, AccountState>();

  const rows = async () => {
    const list = await accountRows(accountProviders(), primaryAccount);
    pendingState.clear();
    for (const row of list) pendingState.set(row.id, row.state);
    return list;
  };

  async function addAccount(ctx: any, providerId?: string, requestedLabel?: string): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Adding an account requires interactive Pi mode.", "error");
      return;
    }

    const providers = accountProviders();
    if (providers.length === 0) {
      ctx.ui.notify("No subscription providers are registered.", "error");
      return;
    }

    let provider = providerId ? accountProvider(providerId) : undefined;
    if (!provider) {
      if (providers.length === 1) {
        provider = providers[0];
      } else {
        const labels = providers.map((p) => `${p.label} (${p.id})`);
        const picked = await ctx.ui.select("Add an account for which subscription?", labels);
        if (!picked) return;
        provider = providers[labels.indexOf(picked)];
      }
    }
    if (!provider) return;

    const label = requestedLabel?.trim()
      || await ctx.ui.input(`${provider.label} account name`, "Work, Personal, etc.");
    if (!label?.trim()) return;

    try {
      const added = await provider.add(bridge(pi, ctx), label.trim());
      if (added) ctx.ui.notify(`${provider.label} account “${added}” added.`, "info");
    } catch (error) {
      ctx.ui.notify(`Could not add account: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function renameAccount(ctx: any): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Renaming an account requires interactive Pi mode.", "error");
      return;
    }
    const list = await accountRows(accountProviders(), primaryAccount);
    const renameable = list.filter((row) => !row.primary && accountProvider(row.providerId)?.rename);
    if (renameable.length === 0) {
      ctx.ui.notify("No accounts can be renamed.", "info");
      return;
    }

    const labels = renameable.map((row) => `${row.providerLabel}  ${row.label}`);
    const picked = await ctx.ui.select("Rename which account?", labels);
    if (!picked) return;
    const row = renameable[labels.indexOf(picked)];
    if (!row) return;

    const next = await ctx.ui.input("New name", row.label);
    if (!next?.trim() || next.trim() === row.label) return;

    const provider = accountProvider(row.providerId);
    try {
      await provider!.rename!(row.id.slice(row.providerId.length + 1), next.trim());
      ctx.ui.notify(`Renamed to “${next.trim()}”.`, "info");
    } catch (error) {
      ctx.ui.notify(`Could not rename: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  pi.registerCommand("accounts", {
    description: "Subscription accounts (/accounts [add|rename|reauth])",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.trim().split(/\s+/).filter(Boolean);
      if (parts.length <= 1) {
        return ["add", "rename", "reauth"]
          .filter((option) => option.startsWith(parts[0] ?? ""))
          .map((option) => ({ value: option, label: option }));
      }
      return accountProviders()
        .map((p) => p.id)
        .filter((id) => id.startsWith(parts[1] ?? ""))
        .map((id) => ({ value: `${parts[0]} ${id}`, label: id }));
    },
    handler: async (args, ctx) => {
      const [action, providerId, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (action === "add") return addAccount(ctx, providerId, rest.join(" ") || undefined);
      if (action === "rename") return renameAccount(ctx);

      if (action === "reauth") {
        const provider = providerId ? accountProvider(providerId) : accountProviders()[0];
        if (!provider) { ctx.ui.notify("No subscription providers are registered.", "error"); return; }
        const target = rest.join(" ") || await pickAccount(ctx, provider);
        if (!target) return;
        try {
          const done = await provider.reauth(bridge(pi, ctx), target);
          if (done) ctx.ui.notify(`${provider.label} account “${done}” reauthorized.`, "info");
        } catch (error) {
          ctx.ui.notify(`Could not reauthorize: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (action) {
        ctx.ui.notify(`Unknown action “${action}”. Use: /accounts [add|rename|reauth]`, "warning");
        return;
      }

      if (!ctx.hasUI) return listAll(ctx);

      // Reopen after each wizard so changes appear immediately.
      for (let step = 0; step < 24; step++) {
        const requested = await openAccountsPicker(ctx, { rows, toggle });
        if (!requested) return;
        if (requested.kind === "add") await addAccount(ctx);
        else if (requested.kind === "rename") await renameAccount(ctx);
      }
    },
  });
}
