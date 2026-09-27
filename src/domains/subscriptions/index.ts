import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProviders } from "../../providers/index.ts";
import { registerAccountCommands } from "./accounts.ts";
import { registerRoutingCommands } from "./routing.ts";
import { registerFooter } from "./footer.ts";

/** Subscription commands and presentation; provider ownership is outside the extension. */
export default function subscriptions(pi: ExtensionAPI) {
  registerProviders(pi);
  registerAccountCommands(pi);
  registerRoutingCommands(pi);
  registerFooter(pi);
}
