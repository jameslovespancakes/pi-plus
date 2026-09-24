import { SettingsList, type Component } from "@earendil-works/pi-tui";
import { hasTruecolor, levelColor } from "../../ui/format.ts";
import { frameSettings, settingsTheme } from "../../ui/settings-picker.ts";

/** Same dot, colors and in-place SettingsList toggle as /provider. */
export function remoteControlPicker(
  theme: any,
  initial: boolean,
  toggle: (enabled: boolean) => boolean,
  done: () => void,
): Component {
  let enabled = initial;
  const color = (value: boolean, text: string) => hasTruecolor()
    ? levelColor(value ? 100 : 0)(text) : theme.fg(value ? "success" : "error", text);
  const label = () => `${color(enabled, "●")} Remote Control`;
  const value = () => color(enabled, enabled ? "On" : "Off");
  const item = {
    id: "remote-control", label: label(), currentValue: value(),
    values: [color(true, "On"), color(false, "Off")],
  };
  const list = new SettingsList([item], 1, settingsTheme(theme), () => {
    enabled = toggle(!enabled);
    item.label = label();
    list.updateValue(item.id, value());
  }, done, { enableSearch: false });
  const frame = frameSettings(theme, list, "Remote Control");
  return {
    ...frame,
    invalidate() {
      item.values = [color(true, "On"), color(false, "Off")];
      item.label = label();
      list.updateValue(item.id, value());
      frame.invalidate();
    },
  };
}
