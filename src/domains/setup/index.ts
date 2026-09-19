import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { env } from "../../core/env.ts";
import { agentPath, readJson } from "../../core/store.ts";
import { configPath, readConfig } from "../../core/config.ts";
import { accountProviders } from "../../core/accounts/registry.ts";
import { readSshHosts } from "../../core/exec/ssh-config.ts";

/**
 * `/pi-plus` — status modal for the whole pack; `/pi-plus help` explains it.
 *
 * The modal lists every feature with its live state. Selecting an unconfigured
 * one runs its setup command; selecting a ready one opens its hub. `help` hands
 * the detected state to the model so the explanation is specific to this
 * machine rather than a static README dump.
 *
 * Only `core/` is read, so this stays inside the layering rules: it never
 * reaches into another domain.
 */

interface Feature {
  name: string;
  ready: boolean;
  detail: string;
  commands: string[];
  /** Command that configures this feature, when it is not ready. */
  setup?: string;
  /** Command that opens this feature once it is ready. */
  open: string;
}

async function inspect(ctx: any): Promise<Feature[]> {
  const config = readConfig();
  const features: Feature[] = [];

  /* subscriptions */
  const providers = accountProviders();
  const accountSummary: string[] = [];
  let anySignedIn = false;
  for (const provider of providers) {
    // pi holds the primary credential itself; the adapter only knows about the
    // extra pooled accounts. Being signed in at all is what makes this usable.
    let primary = false;
    try {
      primary = !!(await ctx.modelRegistry.getProviderAuth(provider.id))?.auth?.apiKey;
    } catch { /* provider not configured */ }

    try {
      const accounts = await provider.list();
      const routing = provider.routing ? await provider.routing.get() : "n/a";
      const pooled = accounts.length + (primary ? 1 : 0);
      anySignedIn ||= primary || accounts.length > 0;
      accountSummary.push(
        primary || accounts.length > 0
          ? `${provider.id}: ${pooled} account(s), routing=${routing}`
          : `${provider.id}: not signed in`,
      );
    } catch {
      accountSummary.push(`${provider.id}: unreadable`);
    }
  }
  features.push({
    name: "Subscription accounts + quota HUD",
    ready: anySignedIn,
    detail: accountSummary.join("; ") || "no account providers registered",
    commands: ["/account", "/account <provider> add", "/routing standard|optimal", "/usage"],
    setup: anySignedIn ? undefined : "/account anthropic add",
    open: "/account",
  });

  /* benchmarks */
  const hasKey = !!env("ARTIFICIAL_ANALYSIS_API_KEY");
  const cache = readJson<{ records?: Record<string, unknown>; checkedAt?: number; fetchedAt?: number }>(
    agentPath("model-quality.json"),
    {},
  );
  const records = Object.keys(cache.records ?? {}).length;
  // Caches written before the store rewrite carry `fetchedAt`.
  const refreshedAt = cache.checkedAt ?? cache.fetchedAt;
  const ageHours = refreshedAt ? Math.round((Date.now() - refreshedAt) / 3.6e6) : undefined;
  features.push({
    name: "Benchmark-driven model selection",
    ready: hasKey && records > 0,
    detail: hasKey
      ? `${records} models cached${ageHours !== undefined ? `, refreshed ${ageHours}h ago` : ""}`
      : "no Artificial Analysis API key",
    commands: ["/models", "/model-info <id>", "/model-info refresh", "list_models (tool)"],
    setup: hasKey ? undefined : "/model-info setup",
    open: "/models",
  });

  /* spend policy */
  features.push({
    name: "Metered spend guardrails",
    ready: config.policy.requireApproval.length > 0,
    detail: `${config.policy.requireApproval.length} gated pattern(s), ${config.policy.autoApprove.length} auto-approved`,
    commands: ["/provider", "/provider list", "/provider approve <name>"],
    open: "/provider",
  });

  /* agent board */
  const boardUrl = env("AGENT_BOARD_URL");
  const boardReady = !!boardUrl && !!env("AGENT_BOARD_TOKEN");
  // A board configured before /board setup existed has no recorded mode; it is
  // externally managed by definition.
  const mode = env("AGENT_BOARD_MODE") ?? (boardReady ? "external" : "none");
  features.push({
    name: "Multi-agent board",
    ready: boardReady,
    detail: boardUrl ? `${mode} at ${boardUrl}` : "no board configured",
    commands: ["/board", "/board setup", "/board restart", "/board clear", "agent_board (tool)"],
    setup: boardReady ? undefined : "/board setup",
    open: "/board status",
  });

  /* remote workers */
  const workers = config.remote.workers ?? [];
  const enabled = workers.filter((worker) => (worker as { enabled?: boolean }).enabled !== false);
  let sshHosts = 0;
  try {
    sshHosts = readSshHosts().length;
  } catch { /* no ssh config */ }
  features.push({
    name: "Remote test workers",
    ready: enabled.length > 0,
    detail: enabled.length > 0
      ? `${enabled.length} enabled of ${workers.length} configured`
      : `none enabled${sshHosts > 0 ? ` (${sshHosts} host(s) available in ~/.ssh/config)` : ""}`,
    commands: ["/remote setup", "/remote add", "remote_test (tool)", "remote_status (tool)"],
    setup: enabled.length > 0 ? undefined : "/remote setup",
    open: "/remote setup",
  });

  return features;
}

/** Unconfigured features sort first: the work to do is what you see first. */
function ordered(features: Feature[]): Feature[] {
  return [...features].sort((a, b) => Number(a.ready) - Number(b.ready));
}

function renderRow(feature: Feature, width: number): string {
  return `[${feature.ready ? "✓" : " "}] ${feature.name.padEnd(width)}  ${feature.detail}`;
}

function buildBrief(features: Feature[]): string {
  const lines = features.map((feature) => {
    const parts = [
      `- ${feature.name} — ${feature.ready ? "READY" : "NOT SET UP"}`,
      `  state: ${feature.detail}`,
      `  commands: ${feature.commands.join(", ")}`,
    ];
    if (feature.setup) parts.push(`  to enable: ${feature.setup}`);
    return parts.join("\n");
  });

  const pending = features.filter((feature) => !feature.ready);

  return [
    "The user just ran /pi-plus. Give them a short, friendly orientation to the pi-plus extension pack.",
    "",
    "Detected state on this machine:",
    "",
    ...lines,
    "",
    `Config file: ${configPath()}${existsSync(configPath()) ? "" : " (not created yet)"}`,
    "",
    "Write the reply yourself, in chat. Requirements:",
    "1. One short sentence on what pi-plus is: four capabilities in one package.",
    "2. A compact list of the capabilities, each with one line on what it does and the command to try. Mark which are already working.",
    pending.length > 0
      ? `3. Then a short 'Set these up next' section covering ONLY the ones marked NOT SET UP (${pending.map((f) => f.name).join(", ")}), each with the single command to run and one line on what it will ask for.`
      : "3. Note that everything is already configured, and suggest one or two commands worth trying.",
    "4. Keep it under ~250 words. No preamble, no headings deeper than one level, no invented features.",
    "5. Do not call any tools. Just answer.",
  ].join("\n");
}

export default function setupGuide(pi: ExtensionAPI) {
  pi.registerCommand("pi-plus", {
    description: "Status modal for every pi-plus feature — or `help` for a full explanation",
    getArgumentCompletions: (prefix) =>
      "help".startsWith(prefix) ? [{ value: "help", label: "help — explain the extension and what is missing" }] : [],
    handler: async (args, ctx) => {
      const features = await inspect(ctx);

      // `/pi-plus help` asks the model to explain the pack and what is missing.
      if (args.trim().toLowerCase() === "help") {
        await pi.sendUserMessage(buildBrief(features));
        return;
      }

      // Everything else is the status modal. ui.select needs a TTY, so headless
      // sessions fall back to the same information as plain text.
      const rows = ordered(features);
      if (!ctx.hasUI) {
        ctx.ui.notify(
          rows
            .map((feature) => `${feature.ready ? "[ready]" : "[setup]"} ${feature.name}\n    ${feature.detail}`)
            .join("\n"),
          "info",
        );
        return;
      }

      const width = Math.max(...rows.map((feature) => feature.name.length));
      const labels = rows.map((feature) => renderRow(feature, width));
      const choice = await ctx.ui.select("pi-plus — enter opens · esc closes", labels);
      if (!choice) return;

      const picked = rows[labels.indexOf(choice)];
      if (!picked) return;

      // Dispatch through the command pipeline rather than importing another
      // domain, which would break the no-cross-domain-imports rule.
      const command = picked.ready ? picked.open : (picked.setup ?? picked.open);
      await pi.sendUserMessage(command, { expandPromptTemplates: true });
    },
  });
}
