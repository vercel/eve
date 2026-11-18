# Slack canvas instructions

`@eve/slack-canvas` is a private workspace extension that adds guidance from a trusted Slack canvas to an eve agent. It uses canvas IDs, not titles, and does not change the built-in Slack channel.

## Mount the extension

1. Add `"@eve/slack-canvas": "workspace:*"` to the agent package’s dependencies.
2. Give the Slack bot access to the canvas and the `files:read` scope. Reinstall the app if you add the scope.
3. Set `SUPPORT_SLACK_BOT_TOKEN` in the agent’s runtime environment to the bot token for the configured workspace.
4. Create `agent/extensions/slack-canvas.ts` with the workspace, channel, and canvas IDs:

```ts
import slackCanvas from "@eve/slack-canvas";

export default slackCanvas({
  workspaces: {
    T0123456789: {
      botTokenEnv: "SUPPORT_SLACK_BOT_TOKEN",
      channels: {
        C0123456789: "F0123456789",
      },
    },
  },
});
```

Omit `channelName` if the channel definition is `agent/channels/slack.ts`. Set it to the channel definition’s name if you use a different filename.

**Only map canvases whose editors you trust to write system instructions for this agent.** Do not put secrets in the canvas. The canvas text is sent to the model and does not replace tool permissions or approval gates.

## What to expect

New turns in a mapped Slack channel read the canvas, including new turns in existing threads. Canvas guidance stays fixed within a turn. The extension extracts text and includes up to 8,000 characters; it does not follow links or download embedded files.

Unmapped conversations and turns without Slack installation metadata get no canvas guidance. If Slack cannot return the canvas, the turn continues without it. Check the canvas ID, bot access, and token environment variable if guidance is missing. This prototype takes an explicit bot token per workspace; it does not reuse Vercel Connect grants automatically.
