import { truncateToWidth, type Component, type SettingsListTheme } from "@earendil-works/pi-tui";

/** Shared inline chrome for provider-style SettingsList pickers. */
export function frameSettings(theme: any, list: Component, title: string): Component {
  const rule = (width: number) => theme.fg("accent", "─".repeat(width));
  return {
    invalidate: () => list.invalidate(),
    handleInput: (data) => list.handleInput?.(data),
    handleMouse: (event) => list.handleMouse?.(event),
    render(width) {
      const inner = Math.max(1, width);
      return [rule(inner), truncateToWidth(` ${theme.fg("accent", theme.bold(title))}`, inner, ""),
        ...list.render(inner), rule(inner)];
    },
  };
}

export function settingsTheme(theme: any): SettingsListTheme {
  return {
    label: (text, selected) => selected ? theme.fg("accent", text) : text,
    value: (text) => text,
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "›"),
    hint: (text) => theme.fg("dim", text),
  };
}
