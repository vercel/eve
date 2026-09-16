import type { PromptCommandExtensionName } from "./prompt-commands.js";
import type { SetupFlowIndicator } from "./setup-flow.js";

/** Presentation shared by setup-command dispatch and its bordered panel. */
export const SETUP_FLOW_CONFIG = {
  "vc:install": { title: "Install the Vercel CLI", indicator: "pulse" },
  "vc:login": { title: "Log in to Vercel", indicator: "pulse" },
  link: { title: "Link to Vercel", indicator: "pulse" },
  model: { title: "Configure the agent model", indicator: "pulse" },
  add: { title: "Add to your agent", indicator: "pulse" },
  deploy: { title: "Deploy to Vercel", indicator: "spinner" },
} satisfies Record<PromptCommandExtensionName, { title: string; indicator: SetupFlowIndicator }>;
