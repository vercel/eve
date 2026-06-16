import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const DISCORD_ROUTE_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/discord.ts": `import { discordChannel } from "eve/channels/discord";

export default discordChannel();
`,
  },
  name: "discord-route-portability",
};
