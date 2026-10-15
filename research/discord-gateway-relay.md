---
issue: TBD
status: implemented
last_updated: "2026-10-15"
---

# Discord Gateway relay

> **AI status:** Written entirely by AI; human review pending.

The Discord channel answers only HTTP Interactions: slash commands, components, and modals.
Discord delivers ordinary messages, such as DMs, mentions, and thread replies, only over its
Gateway WebSocket, which needs a process that stays connected. Apps that want a conversational
bot today copy roughly 450 lines from a template: a Gateway client, a forwarder, and a second
channel that reimplements a subset of `discordChannel` without HITL, error replies, or
attachments. This plan moves both halves into eve so an app only configures them.

## Authoring API

```ts
// agent/channels/discord.ts
export default discordChannel({
  credentials: connectDiscordCredentials("discord/my-agent"),
  gateway: {}, // mounts POST /eve/v1/discord/gateway
  // gateway: { route?, auth?, onMessage?(ctx, message) => { auth, context?, title? } | null }
});

// daemon/main.ts, run as a Vercel Daemon
await runDiscordGatewayRelay({
  credentials: connectDiscordCredentials("discord/my-agent"),
  // url?, route?, auth?, messageContent?, signal?, api?
});
```

`gateway.onMessage` mirrors `onCommand`. `defaultDiscordMessageAuth(message)` mirrors
`defaultDiscordAuth(interaction)`.

## Naming

Both halves are named for the Discord Gateway because the wire format is the Gateway's own: the
relay forwards each `MESSAGE_CREATE` dispatch (`{ op, t, s, d }`) unchanged, and the route parses
it. That makes the route usable by any Gateway client, such as discord.js, without an eve-specific
envelope, and leaves room for more dispatch types without a format change. Docs and logs always
say "Discord Gateway" so it does not read as Vercel AI Gateway.

```text
Discord Gateway ──WS──▶ runDiscordGatewayRelay ──POST {op,t,s,d}──▶ discordChannel gateway route
                         (one instance, OIDC)                        ──REST──▶ Discord
```

## Semantics

- **Addressing.** A message is `addressed` when it is a DM, mentions the bot, replies to the
  bot, or arrives in a thread with a live session. The default `onMessage` dispatches addressed
  messages; a custom one sees every message from a person. Bot authors never reach the hook.
- **Sessions.** DMs and threads map to one session per channel (`<channelId>:channel`); other
  channels map to one per person (`<channelId>:user:<userId>`). Gateway messages omit the
  channel type, so the route looks it up only when an addressed guild message has no session.
- **Delivery.** Gateway sessions have no interaction token, so `channel.discord.post()` sends
  channel messages. They start with `hasMessageAnchor: true`, so replies never re-key the
  session, but prompts with components still alias `<channelId>:<messageId>` and button presses
  arriving as interactions find the session.
- **Identity.** Messages and interactions from the same person share a principal, authenticator
  `discord`, so requester-only approvals asked by a message accept that person's button press.
  This renames the interaction default from `discord-interaction`.
- **Route auth.** Defaults to `localDev()` plus same-project Vercel OIDC from a non-user
  principal. The relay signs with the project's OIDC token by default and forwards without
  credentials when none exists, which `eve dev` accepts.
- **Relay.** Discovers the Gateway URL from `GET /gateway/bot`, identifies with the
  `GUILD_MESSAGES` and `DIRECT_MESSAGES` intents (plus `MESSAGE_CONTENT` on request), resumes
  across reconnects, and forwards dispatches serially with bounded retries and backlog. It stops
  with `DiscordGatewayFatalError` on close codes that reconnecting cannot fix.

## Boundaries

- The relay is a library, not generated code. Deployment wiring (Dockerfile, `vercel.json`
  `daemons`) stays in the app; `eve add channel/discord` could scaffold it later.
- No deduplication. A Gateway sequence number identifies a dispatch only within one session, and
  eve has no idempotent `send`, so overlapping relays during a deploy can answer twice.
- One relay per bot. Sharding is out of scope.
