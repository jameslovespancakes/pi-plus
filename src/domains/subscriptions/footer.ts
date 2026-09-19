import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { refreshUsage, startPolling, stopPolling, subscribe, usageState } from "../../services/usage-service.ts";
import { renderUsageLines, usageSummaryText } from "../../ui/usage-bars.ts";
import { formatTokens, sanitize } from "../../ui/format.ts";

/**
 * Single-line session footer (no working-directory line) with the subscription
 * bars rendered directly underneath it.
 *
 * The footer no longer owns the poll loop — it subscribes to usage-service and
 * re-renders on change. That is what lets non-UI consumers get fresh data.
 */

const SUBSCRIPTION_PROVIDERS = new Set(["anthropic", "openai-codex", "kimi-coding"]);

export function registerFooter(pi: ExtensionAPI): void {
  let showUsage = true;
  let requestRender: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

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

          let input = 0;
          let output = 0;
          let cacheRead = 0;
          let cacheWrite = 0;
          let cost = 0;
          let latestHitRate: number | undefined;

          for (const entry of ctx.sessionManager.getEntries()) {
            const usage = entry.type === "message"
              ? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
              : (entry.type === "branch_summary" || entry.type === "compaction" ? entry.usage : undefined);
            if (!usage) continue;
            input += usage.input ?? 0;
            output += usage.output ?? 0;
            cacheRead += usage.cacheRead ?? 0;
            cacheWrite += usage.cacheWrite ?? 0;
            cost += usage.cost?.total ?? 0;
            if (entry.type === "message" && entry.message.role === "assistant") {
              const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
              latestHitRate = prompt > 0 ? ((usage.cacheRead ?? 0) / prompt) * 100 : undefined;
            }
          }

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
            lines.push(...renderUsageLines(
              usageState(),
              theme,
              width,
              model?.provider === "anthropic" ? model.id : undefined,
            ));
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

  pi.on("model_select", async (_event, ctx) => {
    apply(ctx);
    requestRender?.();
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
