import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  accountProvider,
  accountProviders,
  type AccountContext,
  type AccountProvider,
  type ManagedAccount,
  type RoutingMode,
} from "../../core/accounts/registry.ts";

/**
 * `/account [provider] [add|reauth]` is provider-agnostic account management.
 *
 *   /account                    every provider and its accounts
 *   /account anthropic          that provider's accounts
 *   /account anthropic add      add one
 *   /account anthropic reauth   reauthorize (picker when the label is omitted)
 *
 * No provider-specific logic lives here; adapters are registered in
 * core/accounts/registry.ts.
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
    ui: {
      input: (title, placeholder) => ctx.ui.input(title, placeholder),
      confirm: (title, message) => ctx.ui.confirm(title, message),
      notify: (message, type) => ctx.ui.notify(message, type ?? "info"),
    },
    openBrowser: (url) => openBrowser(pi, url),
  };
}

function describe(account: ManagedAccount): string {
  const state = !account.enabled
    ? "disabled"
    : account.expiresAt !== undefined && account.expiresAt < Date.now() ? "expired" : "active";
  return `${account.label.padEnd(20)} ${state}`;
}

async function listAll(ctx: any): Promise<void> {
  const providers = accountProviders();
  if (providers.length === 0) {
    ctx.ui.notify("No account providers are registered.", "warning");
    return;
  }

  const blocks: string[] = [];
  for (const provider of providers) {
    try {
      const accounts = await provider.list();
      const routing = provider.routing ? ` · routing: ${await provider.routing.get()}` : "";
      blocks.push(
        `${provider.label} (${provider.id})${routing}`,
        ...(accounts.length > 0
          ? accounts.map((account) => `  ${describe(account)}`)
          : [`  no additional accounts, add one with /account ${provider.id} add`]),
      );
    } catch (error) {
      blocks.push(`${provider.label} (${provider.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  ctx.ui.notify(blocks.join("\n"), "info");
}

type HubEntry =
  | { kind: "routing"; provider: AccountProvider; mode: RoutingMode }
  | { kind: "account"; provider: AccountProvider; account: ManagedAccount }
  | { kind: "add"; provider: AccountProvider }
  | { kind: "error" };

async function buildHub(): Promise<{ labels: string[]; entries: HubEntry[] }> {
  const labels: string[] = [];
  const entries: HubEntry[] = [];

  for (const provider of accountProviders()) {
    let accounts: ManagedAccount[] = [];
    try {
      accounts = await provider.list();
    } catch (error) {
      labels.push(`${provider.label}: ${error instanceof Error ? error.message : String(error)}`);
      entries.push({ kind: "error" });
      continue;
    }

    if (provider.routing) {
      const mode = await provider.routing.get();
      labels.push(`${provider.label} · routing: ${mode}   (enter to switch)`);
      entries.push({ kind: "routing", provider, mode });
    } else {
      labels.push(provider.label);
      entries.push({ kind: "error" });
    }

    const width = Math.max(8, ...accounts.map((account) => account.label.length));
    for (const account of accounts) {
      const expired = account.expiresAt !== undefined && account.expiresAt < Date.now();
      const state = !account.enabled ? "disabled" : expired ? "expired, needs reauth" : "active";
      labels.push(`  [${account.enabled ? "✓" : " "}] ${account.label.padEnd(width)}  ${state}`);
      entries.push({ kind: "account", provider, account });
    }

    labels.push(`  + Add ${provider.id} account…`);
    entries.push({ kind: "add", provider });
  }

  return { labels, entries };
}

async function hub(pi: ExtensionAPI, ctx: any): Promise<void> {
  for (;;) {
    const { labels, entries } = await buildHub();
    if (labels.length === 0) {
      ctx.ui.notify("No account providers are registered.", "warning");
      return;
    }

    const choice = await ctx.ui.select("Accounts", labels);
    if (!choice) return;
    const entry = entries[labels.indexOf(choice)];
    if (!entry || entry.kind === "error") continue;

    if (entry.kind === "routing") {
      const next: RoutingMode = entry.mode === "optimal" ? "standard" : "optimal";
      try {
        await entry.provider.routing!.set(next);
      } catch (error) {
        ctx.ui.notify(`Could not change routing: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      continue;
    }

    if (entry.kind === "add") {
      const label = await ctx.ui.input("Account label", "Work, Personal, etc.");
      if (!label) continue;
      try {
        const added = await entry.provider.add(bridge(pi, ctx), label.trim());
        if (added) ctx.ui.notify(`${entry.provider.label} account “${added}” added.`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not add account: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      continue;
    }

    // Account row: toggle eligibility.
    if (!entry.provider.setEnabled) {
      ctx.ui.notify(`${entry.provider.label} does not support disabling accounts.`, "warning");
      continue;
    }
    try {
      await entry.provider.setEnabled(entry.account.id, !entry.account.enabled);
    } catch (error) {
      ctx.ui.notify(`Could not update account: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}

async function pickAccount(ctx: any, provider: AccountProvider): Promise<string | undefined> {
  const accounts = await provider.list();
  if (accounts.length === 0) {
    ctx.ui.notify(`No ${provider.label} accounts yet. Add one with /account ${provider.id} add.`, "info");
    return undefined;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(`Specify an account: /account ${provider.id} reauth <label>`, "warning");
    return undefined;
  }

  const labels = accounts.map(describe);
  const choice = await ctx.ui.select(`Reauthorize which ${provider.label} account?`, labels);
  if (!choice) return undefined;
  return accounts[labels.indexOf(choice)]?.id;
}

export function registerAccountCommands(pi: ExtensionAPI): void {
  pi.registerCommand("account", {
    description: "Manage subscription accounts (/account <provider> [add|reauth])",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) {
        return accountProviders()
          .map((provider) => provider.id)
          .filter((id) => id.startsWith(parts[0] ?? ""))
          .map((id) => ({ value: id, label: id }));
      }
      const action = parts[1] ?? "";
      return ["add", "reauth"]
        .filter((option) => option.startsWith(action))
        .map((option) => ({ value: `${parts[0]} ${option}`, label: option }));
    },
    handler: async (args, ctx) => {
      const [providerId, action, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      // Bare /account opens the toggle hub; headless sessions get plain text.
      if (!providerId) return ctx.hasUI ? hub(pi, ctx) : listAll(ctx);

      const provider = accountProvider(providerId);
      if (!provider) {
        const known = accountProviders().map((entry) => entry.id).join(", ") || "none";
        ctx.ui.notify(`Unknown provider “${providerId}”. Available: ${known}`, "error");
        return;
      }

      if (!action) {
        const accounts = await provider.list();
        const routing = provider.routing ? `\nrouting: ${await provider.routing.get()}` : "";
        ctx.ui.notify(
          (accounts.length > 0
            ? accounts.map(describe).join("\n")
            : `No additional ${provider.label} accounts. Add one with /account ${provider.id} add.`) + routing,
          "info",
        );
        return;
      }

      const context = bridge(pi, ctx);

      if (action === "add") {
        if (!ctx.hasUI) {
          ctx.ui.notify("Adding an account requires interactive Pi mode.", "error");
          return;
        }
        const label = rest.join(" ") || await ctx.ui.input("Account label", "Work, Personal, etc.");
        if (!label) return;
        try {
          const added = await provider.add(context, label.trim());
          if (added) ctx.ui.notify(`${provider.label} account “${added}” added.`, "info");
        } catch (error) {
          ctx.ui.notify(`Could not add account: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (action === "reauth") {
        const target = rest.join(" ") || await pickAccount(ctx, provider);
        if (!target) return;
        try {
          const done = await provider.reauth(context, target);
          if (done) ctx.ui.notify(`${provider.label} account “${done}” reauthorized.`, "info");
        } catch (error) {
          ctx.ui.notify(`Could not reauthorize: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      ctx.ui.notify(`Unknown action “${action}”. Use: /account ${provider.id} [add|reauth]`, "warning");
    },
  });
}
