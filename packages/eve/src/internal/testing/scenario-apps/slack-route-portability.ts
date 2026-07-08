import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const SLACK_ROUTE_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/slack.ts": `import {
  defaultInputRequestedHandler,
  slackChannel,
  type SlackChannelEvents,
} from "eve/channels/slack";

const inputRequested: NonNullable<SlackChannelEvents["input.requested"]> =
  defaultInputRequestedHandler();

export default slackChannel({
  botName: "testbot",
  events: {
    "input.requested": inputRequested,
  },
});
`,
  },
  name: "slack-route-portability",
};
