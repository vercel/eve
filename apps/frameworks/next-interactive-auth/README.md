# Next.js interactive channel auth example

This app exercises durable sender authentication from both the eve HTTP channel and Slack with one Next.js sign-in page. When either channel receives a message from an unknown sender, eve parks the accepted message before model or tool execution. The channel sends the user to `/sign-in`; submitting a name and email completes the callback, installs the email as `principalId`, and resumes the original message.

The chat UI on `/` uses `useEveAgent()` and renders the default `authorization` message part as a sign-in link. It keeps streaming after the callback. Slack delivers the same challenge privately with its default authorization handler.

## Configure the app

The browser test only needs the public origin that serves the Next.js app:

```sh
AUTH_FORM_ORIGIN=http://localhost:3003
```

To test Slack too, also set its credentials:

```sh
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-signing-secret
```

Configure the Slack app's event and interaction request URLs as `https://your-public-app.example/eve/v1/slack`. Subscribe to `app_mention`; add `message.im` and the `im:history` scope to test DMs. See the [Slack channel setup](../../../docs/channels/slack.mdx#manage-slack-credentials-yourself) for the complete app and scope configuration.

`AUTH_FORM_ORIGIN` must be the origin that serves the Next.js app. `http://localhost:3003` works for the browser test. For Slack, expose the app through a tunnel and use that public HTTPS origin instead.

## Run the example

```sh
AUTH_FORM_ORIGIN=http://localhost:3003 pnpm --filter framework-next-interactive-auth dev
```

Open the app and send a message, or mention or DM the bot in Slack. Open the sign-in link, submit the form, and return to the original channel. The `whoami` tool reads `ctx.session.auth.current`, allowing the agent to confirm that the completed form became the session auth context.

This app is for local and preview testing. The form does not verify email ownership, its eve stream route is intentionally readable for browser testing, and its bounded in-memory sender mapping is lost on restart or a serverless cold start. Replace these test shortcuts with application route auth, a verified sign-in flow, and a durable account store before using this pattern in production.
