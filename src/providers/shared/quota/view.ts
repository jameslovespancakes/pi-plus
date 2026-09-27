/** Display data only: terminal rendering has no provider or account rules. */
export type Cell = { label: string; remaining?: number; resetAt?: number; partial?: boolean; active?: boolean };
export type Column = { title: string; cells: Cell[] };
export interface ActiveModel { provider?: string; modelId?: string }
export interface UsageView {
  loading: boolean;
  empty: boolean;
  errors: readonly string[];
  columns: readonly [Column, Column];
  accountSummary?: string;
}
