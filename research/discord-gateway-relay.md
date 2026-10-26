---
issue: https://github.com/vercel/eve/pull/4934
status: implemented
last_updated: "2026-10-19"
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
await experimental_runDiscordGatewayRelay({
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
Discord Gateway ──WS──▶ experimental_runDiscordGatewayRelay ──POST {op,t,s,d}──▶ discordChannel gateway route
                         (one instance, OIDC)                        ──REST──▶ Discord
```

## Semantics

- **Addressing.** A message is `addressed` when it is a DM, mentions the bot, replies to the
  bot, or arrives in a thread with a live session. The default `onMessage` dispatches addressed
  messages; a custom one sees every message from a person. Bot authors never reach the hook.
- **Sessions.** DMs and threads map to one session per channel (`<channelId>:channel`). In a
  text channel, a mention starts a thread (see Threads), and a reply continues whichever live
  session owns the replied-to message. With threads off, a mention starts a session keyed by the
  message (`<channelId>:<messageId>`). `onMessage` can
  return `conversation` to choose the key instead, such as `user:<userId>` for one session per
  person. Gateway messages omit the channel type, so the route looks it up only when the
  default needs it.
- **Threads.** By default a message that would open a new session in a text channel starts a
  public thread, adds the author, and keys the session `<threadId>:channel`, as the Slack
  channel answers in threads. `gateway.startThread: false` answers in the channel instead, where
  a mention starts a session keyed by the message and replies continue it; an `onMessage` result's
  `startThread` decides per message. DMs, thread messages, and replies that continue a session are
  untouched, and a refused creation falls back to the channel.
- **Delivery.** Gateway sessions have no interaction token, so `channel.discord.post()` sends
  channel messages. They start with `hasMessageAnchor: true`, so replies never re-key the
  session. Every message the bot posts, in any Discord session, aliases
  `<channelId>:<messageId>`, so both a button press and a Gateway reply find the session that
  posted it.
- **Identity.** Messages and interactions from the same person share a principal, including the
  existing `discord-interaction` authenticator, so requester-only approvals asked by a message
  accept that person's button press. Keeping the old authenticator string avoids orphaning
  existing principals, pending approvals, and per-user tool sessions.
- **Route auth.** The body asserts the author's identity, so the default is narrower than
  ordinary route auth: `localDev()` plus Vercel OIDC from this project's runtime in the same
  environment (`principalType: "runtime"`). A preview deployment cannot post to production. The relay signs with the project's OIDC token by default and forwards without
  credentials when none exists, which `eve dev` accepts.
- **Route contract.** The body is a raw Gateway dispatch, capped at 1 MB. Responses: `202`
  dispatched, `200 { accepted: false, reason }` ignored, `400` not JSON, `401` auth, `413` too
  large, `429` rate limited (retryable), `5xx` unknown, since a platform timeout can follow a
  dispatch. eve does not deduplicate.
- **Relay.** Discovers the Gateway URL from `GET /gateway/bot`, identifies with the
  `GUILD_MESSAGES` and `DIRECT_MESSAGES` intents (plus `MESSAGE_CONTENT` on request), resumes
  across reconnects, and forwards dispatches serially with a bounded backlog. It retries only a
  `429` or a connection that failed before the request reached eve, never a `5xx` or a timeout. It stops
  with `DiscordGatewayFatalError` on close codes that reconnecting cannot fix.

## Boundaries

- The relay is a library, not generated code. Deployment wiring (Dockerfile, `vercel.json`
  `daemons`) stays in the app; `eve add channel/discord` could scaffold it later.
- No deduplication. A Gateway sequence number identifies a dispatch only within one session, and
  eve has no idempotent `send`, so two relays connected at once, or a retry after eve started a turn,
  can answer twice.
- No cross-process resume. A deploy or restart starts a new Gateway session, so messages sent while
  no relay is connected are lost. Handing the session cursor to the next process is a follow-up.
- One relay per bot. Sharding is out of scope.
