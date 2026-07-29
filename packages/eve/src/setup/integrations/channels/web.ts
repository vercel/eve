import type { ChannelSetupIntegration } from "./types.js";
import { runChannelSetup } from "./runner.js";

/** Web Chat's channel-owned setup behavior. */
export const WEB_CHANNEL_SETUP: ChannelSetupIntegration = {
  kind: "web",
  label: "Web Chat",
  hint: "Browser-based chat interface",
  setup(context) {
    return runChannelSetup(context, {
      configureVercelServices: context.environment.vercel.kind === "available",
    });
  },
};
