---
title: "Upgrade Channels"
description: "Update Slack, Teams, MCP, and custom channel code for eve 1.0."
navTitle: "Channels"
---

Read this page if your agent uses a built-in channel such as Slack, Teams, or MCP, or defines its own channel. Channel `events` handlers also changed signature; see [Channel `events` handlers](/docs/guides/upgrade/session-events#channel-events-handlers).

This page is part of [Upgrade to 1.0](/docs/guides/upgrade).

## Slack

- **Cards.** Call card builders with their data forms, use `CardText` for labels, and use `cardToFallbackText` for whole cards. Remove imports of `Modal*`, `TextInput*`, `ExternalSelect*`, `CardJSXElement`, `CardJSXProps`, `isCardElement`, `cardChildToFallbackText`, `ChatElement`, `ContainerProps`, and the builder `*Props` types. Use native Slack view data for custom modals. See [Slack cards](/docs/channels/slack/reference#cards).

  ```ts
  Actions({ children: [Button({ id: "approve", children: "Approve" })] }); // [!code --]
  Actions([Button({ id: "approve", label: "Approve" })]); // [!code ++]
  ```

- **Renderers.** `renderers.taskCard` receives a `TaskCard`; use `callState` and `callLabel` from `eve/events` to render calls. `SlackTaskCard` is `SlackCardMessage`. To restyle approval and question cards, use `renderers.interactionCard`. See [Restyle approval and question cards](/docs/channels/slack/reference#restyle-approval-and-question-cards).
- **State.** `SlackChannelState.pendingApprovalCards` is `interactionCards`. Cards posted before the upgrade keep their buttons. `SlackSessionTarget` is a union that includes `{ channelId, codeChannel: true }`, so handle that variant before you read `target.threadTs`.
- **Model context.** The model sees sender, bot, and thread metadata in `<sender>`, `<bot>`, and `<thread>` blocks. Update instructions that mention `sender_type`, `sender_id`, `bot_user_id`, or `is_mentioned`.
- **Proactive messages.** `initialMessage` accepts `{ text }`, `{ markdown }`, `{ blocks, text? }`, or `{ card }`. See [proactive sessions](/docs/channels/slack/reference#proactive-sessions).

## Identity, audience, and options

- Authored channel identity is `channel:<name>`, including route-only channels and the default `channel:eve`, which replaces `http`. Update visibility and authorization rules that match the old names.
- Move visibility classification from `metadata().audience` to `audience(input)`. Without it, the audience is `unknown`.
- Channel context factories take `context(state, channel)`. Continuation aliases live on `channel.continuation`.
- Channel delivery hooks receive typed `ChannelDelivery` payloads and return replacements. Use `channel.state` for state changes. Remove `kindHint`.
- Rename the CORS options `allowedHeaders`, `exposedHeaders`, and `preflightStatus` to `allowHeaders`, `exposeHeaders`, and `preflight.statusCode`.
- Sends, channels, and schedules accept `MessageContent`; send images as file parts. In Chat SDK channels, rename `messageToUserContent` to `messageContentOf`.

See [Custom channels](/docs/channels/custom).

## Other channels

- **Teams.** Channel state uses `pendingAuthActivityIds` instead of `pendingAuthActivityId`.
- **MCP.** An `input_required` status can mean a sign-in as well as an approval or a question. Answer approvals and questions with `responses: [{ interactionId, optionId?, text? }]`. A sign-in completes outside MCP. Direct `invokeTool` calls return the call's outcome instead of pausing the conversation. See [MCP](/docs/channels/mcp).
- **Vercel OIDC tool stubs.** `vercelOidc` from `eve/channels/auth` only authenticates. If a `subjects` entry sets `allowToolStubs`, switch to `eveVercelOidc` from `eve/channels/eve`, which takes the same options. Type a custom callback that returns `allowToolStubs` as `EveAuthFn` or `EveAuthResult`.

```ts
import { vercelOidc } from "eve/channels/auth"; // [!code --]
import { eveVercelOidc } from "eve/channels/eve"; // [!code ++]

vercelOidc({ // [!code --]
eveVercelOidc({ // [!code ++]
  subjects: [{ subject: evalRunner, allowToolStubs: true }],
});
```

## Keep custom data in your own state keys

The built-in channels' default handlers keep internal fields in channel state. Those fields aren't part of the public state types, so don't read or write them; store your own handler data under your own keys. The internal fields include:

- Slack `taskCards` and `threadStatus`
- Chat SDK streaming fields
- `pendingSignIns`, posted prompt cards, `shownPromptId`, and `undeliveredReplyErrorId`
- Discord `interactionToken`, `initialResponseSent`, and `hasMessageAnchor`. Read the interaction token from the Discord handle instead.

`TelegramHitlState` isn't exported. Addressing, identity, and audience fields are unchanged.
