import type { Component } from "@earendil-works/pi-tui";
import { hasTruecolor, levelColor } from "../../ui/format.ts";

/**
 * The `/provider` picker.
 *
 * Built on SettingsList so toggling happens *in place*: the component persists
 * and only its value strings change, rather than the dialog closing and
 * reopening on every keypress, which caused a full-screen redraw (the flicker).
 *
 * States are colour coded rather than prefixed, so the list reads at a glance:
 *
 *   Allowed          green    reachable without a prompt
 *   Approved         cyan     metered, granted for this session
 *   Needs Approval   yellow   metered, will prompt
 *   Denied           red      blocked by policy outright
 */

export const STATE_TEXT = {
  auto: "Allowed",
  approved: "Approved",
  blocked: "Needs Approval",
  denied: "Denied",
} as const;

export type StateKey = keyof typeof STATE_TEXT;

/** The two values SettingsList cycles between for a binary toggle. */
export const TOGGLE_VALUES = [STATE_TEXT.auto, STATE_TEXT.blocked];

export interface ProviderRow {
  /** Stable id used by SettingsList and by the toggle handler. */
  id: string;
  /** Provider id this row controls. */
  provider: string;
  /** Human name, e.g. "Anthropic" or "OpenRouter". */
  display: string;
  state: StateKey;
}

/**
 * Where each state sits on the usage-bar gradient.
 *
 * `levelColor` maps 0-100 onto the same red-to-green ramp the quota bars use,
 * so "Allowed" is the green of a full bar and "Needs Approval" is the amber of
 * one running low. Reusing the ramp keeps the two surfaces consistent instead
 * of pairing a bespoke green here with a different green in the footer.
 */
const STATE_LEVEL: Record<StateKey, number> = {
  auto: 100,
  approved: 100,
  blocked: 45,
  denied: 0,
};

/** Fallback for terminals without truecolor. */
const STATE_THEME_COLOUR: Record<StateKey, string> = {
  auto: "success",
  approved: "success",
  blocked: "warning",
  denied: "error",
};

/**
 * Colour a state string. Kept separate from rendering so callers can reuse it
 * for notices and be consistent with the list.
 */
export function colourState(theme: any, state: StateKey, text: string = STATE_TEXT[state]): string {
  // Approved shares auto's green: both mean usable, and a third hue would imply
  // a third risk level. The label already distinguishes them.
  if (hasTruecolor()) return levelColor(STATE_LEVEL[state])(text);
  return theme.fg(STATE_THEME_COLOUR[state], text);
}

/** The row label: a status dot on the usage-bar ramp, plus the name. */
function labelFor(theme: any, row: ProviderRow): string {
  const dot = colourState(theme, row.state, "●");
  const name = row.state === "denied" ? theme.fg("muted", row.display) : row.display;
  return `${dot} ${name}`;
}

/**
 * The chrome pi uses for `/model` and its other in-chat pickers.
 *
 * Not a box: a full-width accent rule, a bold title, the body, then a closing
 * rule. Reproduced from pi's own `frame(theme, title, body, footer)` helper so
 * this reads as part of the chat flow rather than as a floating dialog.
 *
 * Input and mouse events pass straight through, so the frame is presentation
 * only and does not disturb the in-place updates.
 */
function framed(theme: any, list: any, title: string): Component {
  const rule = (width: number) => theme.fg("accent", "─".repeat(Math.max(1, width)));

  return {
    invalidate: () => list.invalidate?.(),
    handleInput: (data: string) => list.handleInput(data),
    handleMouse: (event: any) => list.handleMouse?.(event),
    render(width: number): string[] {
      const inner = Math.max(1, width);
      // pi pads title and footer by one column; the list renders flush.
      return [
        rule(inner),
        ` ${theme.fg("accent", theme.bold(title))}`,
        ...list.render(inner),
        rule(inner),
      ];
    },
  } as Component;
}

/**
 * Theme for the picker. Every callback takes `selected` so the highlighted row
 * can be emphasised without the caller tracking cursor position.
 */
function pickerTheme(theme: any) {
  return {
    label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
    value: (text: string, _selected: boolean) => text,
    description: (text: string) => theme.fg("dim", text),
    cursor: theme.fg("accent", "›"),
    hint: (text: string) => theme.fg("dim", text),
  };
}

export interface PickerDeps {
  /** Re-reads the current rows, so the picker never shows stale state. */
  rows: () => Promise<ProviderRow[]>;
  /**
   * Applies a toggle and returns the resulting state.
   *
   * Deliberately synchronous. SettingsList cycles its own `values` the instant
   * Enter is pressed, so an async toggle would let the text change one frame
   * before the colour caught up. Keeping it sync means the label, the dot and
   * the value all land in the same render.
   */
  toggle: (provider: string) => StateKey;
}

/**
 * Opens the picker and resolves when the user cancels.
 *
 * The loop only re-enters when the row set itself changes (for example a
 * provider appearing after re-authentication); ordinary toggles just call
 * `updateValue`, which is a single re-render of one component.
 */
export async function openProviderPicker(ctx: any, deps: PickerDeps): Promise<void> {
  const { SettingsList } = await import("@earendil-works/pi-tui");

  const initial = await deps.rows();
  if (initial.length === 0) {
    ctx.ui.notify("No providers are configured. Sign in with /account or pi auth.", "info");
    return;
  }

  await ctx.ui.custom((_tui: any, theme: any, _keys: any, done: (v: void) => void) => {
    const rows = initial;
    let list: any;

    // Held by reference: SettingsList reads these objects on every render, so
    // mutating `label` here recolours the status dot without rebuilding the
    // component. `updateValue` only refreshes the value column.
    // `values` carries the COLOURED strings, not plain text. SettingsList shows
    // whichever it cycles to immediately, so pre-colouring them means the new
    // text arrives already in the right colour rather than flashing uncoloured.
    const colouredToggle = [colourState(theme, "auto"), colourState(theme, "blocked")];

    const items = rows.map((row) => ({
      id: row.id,
      label: labelFor(theme, row),
      values: [...colouredToggle],
      currentValue: colourState(theme, row.state),
    }));

    // Synchronous throughout: label, dot and value all change in one render.
    const onChange = (id: string) => {
      const row = rows.find((r) => r.id === id);
      const item = items.find((i) => i.id === id);
      if (!row || !item) return;

      if (row.state === "denied") {
        // Undo the value SettingsList optimistically cycled to.
        list?.updateValue(id, colourState(theme, row.state));
        ctx.ui.notify(`${row.display} is denied in policy. Edit pi-plus.json to change that.`, "warning");
        return;
      }

      const next = deps.toggle(row.provider);
      row.state = next;
      item.label = labelFor(theme, row);
      list?.updateValue(id, colourState(theme, next));
      list?.invalidate?.();
    };

    list = new SettingsList(
      items,
      12,
      pickerTheme(theme),
      onChange,
      () => done(undefined),
      { enableSearch: false },
    );

    return framed(theme, list, "Providers") as Component & { dispose?(): void };
  });
  // No `overlay` option: the picker renders inline in the chat flow rather than
  // floating over it.
}