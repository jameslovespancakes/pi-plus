import type { UsageState } from "../usage/service.ts";
import type { Cell, Column } from "../shared/quota/view.ts";

function codexCell(state: UsageState, display: string, match: (label: string) => boolean): Cell | undefined {
  const row = state.rows.find((candidate) => candidate.group === "Codex" && match(candidate.label));
  return row ? { label: display, remaining: row.remaining, resetAt: row.resetAt } : { label: display };
}

export function codexColumn(state: UsageState): Column {
  // Codex reports only the two windows; it has no scoped equivalent.
  const cells: Cell[] = [
    codexCell(state, "5h", (label) => label === "5h") ?? { label: "5h" },
    codexCell(state, "weekly", (label) => label === "weekly") ?? { label: "weekly" },
  ];
  return { title: state.codexPlan ? `Codex · ${state.codexPlan}` : "Codex", cells };
}

export function codexQuotaLeft(state: UsageState): number | undefined {
  const row = state.rows.find((candidate) => candidate.group === "Codex" && candidate.label === "weekly");
  return row ? Math.round(row.remaining) : undefined;
}
