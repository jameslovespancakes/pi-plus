/** Existing durable quota schema shared by Anthropic and Codex. No storage migration. */
export interface QuotaWindow {
  capacity?: number;
  remainingPercent?: number;
  usedPercent?: number;
  resetsAt?: string;
  checkedAt?: number;
  id?: string;
}

export interface QuotaSnapshot {
  five_hour?: QuotaWindow;
  seven_day?: QuotaWindow;
  extra?: QuotaWindow;
  scoped?: QuotaWindow[];
  checkedAt?: number;
  source?: "poll" | "headers";
  [key: string]: unknown;
}
