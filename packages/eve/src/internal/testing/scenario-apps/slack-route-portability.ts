import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const SLACK_ROUTE_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/slack.ts": `import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  botName: "testbot",
});
`,
  },
  name: "slack-route-portability",
};
