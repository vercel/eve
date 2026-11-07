---
issue: "None (maintainer-requested in PR #6106)"
status: proposed
last_updated: "2026-11-06"
---

# Conversation spaces

> **AI status:** Written entirely by AI; human review pending.

## Problem

Code that shares data per place, such as skills or memory for everyone in a
Slack channel, has no channel-neutral way to name the place. Today it reads
platform attributes off the caller's auth (`attributes.channel_id`,
`team_id`, `guild_id`) and needs per-platform rules for each:

- Slack, Discord, and Teams each name the channel and workspace differently.
- Telling a DM from a shared channel takes platform knowledge: a `D` prefix in
  Slack, a missing guild in Discord, a conversation type in Teams.
- The Slack `team_id` on auth differs between messages and button clicks for
  Slack Connect and Enterprise Grid users, so the same channel can read as two
  places.

eve already has nearby concepts, and none of them fits:

| Concept                         | Why it doesn't name a place                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `ctx.conversation.audience`     | A trace-capture classification with no ID. Slack private channels read `private` too. |
| `ctx.channel.continuationToken` | One Slack thread, not its channel.                                                    |
| `ctx.channel.metadata`          | Channel-specific shape; Discord exposes none.                                         |
| `ctx.channel.kind`              | `channel:<authored name>`, set by the agent's file name, not the platform.            |

## Proposal

Channels report a **space**: the place on the platform where the conversation
happens. It joins the session's `ConversationContext` beside `audience`, and
tools, approval policies, dynamic values, and memory scopes read it as
`ctx.conversation.space`.

```ts
interface ConversationSpace {
  /** Stable, namespaced by platform and workspace: `slack:T0123:C0456`. */
  readonly id: string;
  readonly type: "direct" | "group" | "channel";
  /** `slack:T0123`; absent when the platform has no workspace. */
  readonly workspaceId?: string;
}
```

- `direct`: one person and the agent. `group`: a private conversation among a
  fixed set of people. `channel`: a named place that members join.
- A channel reports it with a synchronous `space({ state })` hook, next to
  `audience({ state, caller })`. A missing, throwing, asynchronous, or
  malformed result reports no space.
- Like the audience, the space is fixed when the session is created, and a
  local subagent inherits its parent's.
- `ctx.conversation` is added to `SessionContext` (tools, approval policies,
  channel events) and `MemoryScopeContext`. Dynamic values already have it.

Built-in channels report:

| Channel  | `id`                                               | Workspace         |
| -------- | -------------------------------------------------- | ----------------- |
| Slack    | `slack:<installation team>:<channel>`              | Installation team |
| Discord  | `discord:<guild>:<channel>` or `discord:<channel>` | Guild             |
| Teams    | `teams:<tenant>:<channel or chat>`                 | Tenant            |
| Telegram | `telegram:<chat>`                                  | None              |
| Chat SDK | `<adapter>:<channel>`                              | None              |

Slack uses the installation team, which stays the same for every member of a
Slack Connect channel. A Teams channel conversation reports the Teams channel,
not the thread its conversation ID names.

## Boundaries

- A space names a place. It is not an access control: who may change data in a
  space is still decided from `ctx.session.auth.current`.
- The space isn't added to trace attributes. Trace policies receive it through
  `TraceCaptureContext`, which spreads `ConversationContext`.
- Channels that have no natural place (HTTP, MCP, GitHub, Linear, SMS) report
  none for now.

## Open questions

- Discord threads report themselves, because the channel state has no parent
  channel ID. Recording the parent would let a thread share its channel's space.
- Whether `group` should split into a "private channel" type for platforms
  where private channels are joinable but not public.
