import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const SLACK_CUSTOM_CHANNEL_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/slack.ts": `import { Actions, Button, Card, CardText, slackChannel } from "eve/channels/slack";

const ALLOWED = new Set(["C0123ABC"]);

export default slackChannel({
  onAppMention(ctx, message) {
    if (!ALLOWED.has(ctx.slack.channelId)) return null;
    return {
      auth: {
        attributes: {},
        authenticator: "slack",
        principalId: message.author?.userId ?? "unknown",
        principalType: "user",
      },
    };
  },

  events: {
    "message.completed"(event, ctx) {
      if (event.finishReason === "tool-calls") return;
      if (event.message) {
        ctx.thread.post(event.message);
        ctx.thread.post(
          Card({
            children: [
              CardText("Was this helpful?"),
              Actions([
                Button({ id: "yes", label: "Yes", style: "primary" }),
                Button({ id: "no", label: "No" }),
              ]),
            ],
          }),
        );
      }
    },
  },

  onInteraction(action, _ctx) {
    console.log("Feedback:", action.actionId);
  },
});
`,
  },
  name: "slack-custom-channel-portability",
};
