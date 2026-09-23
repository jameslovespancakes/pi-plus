import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isGeminiAccount } from "../../core/quota/pool.ts";
import {
  configureUsageSources,
  refreshUsage,
  startPolling,
  stopPolling,
  subscribe,
  usageState,
} from "../../services/usage-service.ts";
import { renderUsageLines, usageSummaryText } from "../../ui/usage-bars.ts";
import { formatTokens, sanitize } from "../../ui/format.ts";

/** Compact session footer with shared subscription usage bars. */

const SUBSCRIPTION_PROVIDERS = new Set(["anthropic", "openai-codex", "gemini", "kimi-coding", "xai"]);

interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestHitRate?: number;
}

function usageFor(entry: any): any {
  if (entry.type === "message") {
    return entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined;
  }
  return entry.type === "branch_summary" || entry.type === "compaction" ? entry.usage : undefined;
}

function sumSessionUsage(entries: any[]): SessionTotals {
  const totals: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    const usage = usageFor(entry);
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      totals.latestHitRate = prompt > 0 ? ((usage.cacheRead ?? 0) / prompt) * 100 : undefined;
    }
  }
  return totals;
}

function usageSignature(entries: any[]): string {
  const last = entries.at(-1);
  const usage = last ? usageFor(last) : undefined;
  return [entries.length, last?.id, usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite, usage?.cost?.total].join(":");
}

/**
 * True when the column the footer shows for `provider` has nothing to draw
 * yet, e.g. right after a first `/login gemini`. Waiting for the next poll
 * would leave the swapped-in column empty for minutes.
 */
function columnIsEmpty(provider: string | undefined): boolean {
  const rows = usageState().rows;
  if (provider === "gemini") return !rows.some(isGeminiAccount);
  if (provider === "openai-codex") return !rows.some((row) => row.group === "Codex");
  return false;
}

export function registerFooter(pi: ExtensionAPI): void {
  // The primary account's quota must be read from pi's store as-is; the
  // registry would hand back whichever pooled account routing picked.
  configureUsageSources({ readCredential: (providerId) => readStoredCredential(providerId) });

  let showUsage = true;
  let requestRender: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let cachedUsage: { signature: string; totals: SessionTotals } | undefined;

  const apply = (ctx: any) => {
    if (!ctx.hasUI) return;
    if (!showUsage) {
      ctx.ui.setFooter(undefined);
      return;
    }

    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      requestRender = () => tui.requestRender();
      return {
        invalidate() {},
        render(rawWidth: number): string[] {
          const width = Math.max(1, Math.floor(Number(rawWidth) || 0));
          const lines: string[] = [];

          const entries = ctx.sessionManager.getEntries();
          const signature = usageSignature(entries);
          if (cachedUsage?.signature !== signature) {
            cachedUsage = { signature, totals: sumSessionUsage(entries) };
          }
          const { input, output, cacheRead, cacheWrite, cost, latestHitRate } = cachedUsage.totals;

          const parts: string[] = [];
          if (input) parts.push(`↑${formatTokens(input)}`);
          if (output) parts.push(`↓${formatTokens(output)}`);
          if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
          if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
          if ((cacheRead || cacheWrite) && latestHitRate !== undefined) parts.push(`CH${latestHitRate.toFixed(1)}%`);

          const model = ctx.model;
          const subscription = model ? SUBSCRIPTION_PROVIDERS.has(model.provider) : false;
          if (cost || subscription) parts.push(`$${cost.toFixed(3)}${subscription ? " (sub)" : ""}`);

          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
          const percentValue = contextUsage?.percent ?? 0;
          const percentText = contextUsage?.percent != null ? `${percentValue.toFixed(1)}%` : "?";
          const contextText = `${percentText}/${formatTokens(contextWindow)}`;
          parts.push(percentValue > 90
            ? theme.fg("error", contextText)
            : percentValue > 70 ? theme.fg("warning", contextText) : contextText);

          const branch = footerData.getGitBranch?.();
          if (branch) parts.push(`⎇ ${branch}`);

          let left = parts.join(" ");
          if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
          let leftWidth = visibleWidth(left);

          let right = model?.id ?? "no-model";
          if (model?.reasoning) {
            const level = ctx.thinkingLevel || "off";
            right = level === "off" ? `${right} • thinking off` : `${right} • ${level}`;
          }
          if (footerData.getAvailableProviderCount?.() > 1 && model) {
            const withProvider = `(${model.provider}) ${right}`;
            if (leftWidth + 2 + visibleWidth(withProvider) <= width) right = withProvider;
          }

          // Keep the composed line within `width`: shrink right, then left.
          let rightWidth = visibleWidth(right);
          if (rightWidth > width) {
            right = truncateToWidth(right, width, "...");
            rightWidth = visibleWidth(right);
          }
          if (leftWidth + 2 + rightWidth > width) {
            const leftBudget = Math.max(0, width - rightWidth - 2);
            left = leftBudget > 0 ? truncateToWidth(left, leftBudget, "...") : "";
            leftWidth = visibleWidth(left);
          }
          const padding = " ".repeat(Math.max(0, width - leftWidth - rightWidth));
          lines.push(truncateToWidth(theme.fg("dim", left) + theme.fg("dim", padding + right), width, ""));

          const statuses = footerData.getExtensionStatuses?.() as Map<string, string> | undefined;
          if (statuses && statuses.size > 0) {
            const statusLine = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => sanitize(text))
              .join(" ");
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }

          if (showUsage) {
            // The right-hand column follows the provider in use.
            lines.push(...renderUsageLines(usageState(), theme, width, { provider: model?.provider, modelId: model?.id }));
          }

          // Final safety net: never emit a line wider than the terminal.
          return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
        },
      };
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    apply(ctx);
    unsubscribe ??= subscribe(() => requestRender?.());
    // Polling is started even without a UI so headless consumers stay current.
    startPolling(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    apply(ctx);
    requestRender?.();
    // The swap itself is immediate; fetch only if the new column has no figures.
    if (ctx.hasUI && showUsage && columnIsEmpty(event.model?.provider)) void refreshUsage(ctx, true);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Status polling is cosmetic: never hold up agent completion on auth/network.
    if (ctx.hasUI && showUsage) void refreshUsage(ctx);
  });

  pi.on("session_shutdown", async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    stopPolling();
  });

  pi.registerCommand("usage", {
    description: "Refresh, hide, or show the subscription bars (on | off | text)",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "text"]
        .filter((option) => option.startsWith(prefix))
        .map((option) => ({ value: option, label: option })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "off") {
        showUsage = false;
        apply(ctx);
        requestRender?.();
        ctx.ui.notify("Usage bars hidden. Use /usage on to restore them.", "info");
        return;
      }
      if (action === "on") showUsage = true;
      await refreshUsage(ctx, true);
      apply(ctx);
      if (action === "text" || !ctx.hasUI) ctx.ui.notify(usageSummaryText(usageState()), "info");
      else if (usageState().errors.length > 0) ctx.ui.notify(usageState().errors.join("\n"), "warning");
    },
  });

}
