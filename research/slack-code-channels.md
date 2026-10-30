---
issue: TBD
status: in-progress
last_updated: "2026-10-26"
---

# Slack code channels

> **AI status:** Written entirely by AI; human review pending.

> **Implementation status:** Phase 1 is partly in. Shipped: detection, `code:C123` keying, top-level
> replies, session status, stop, and `codeChannels: true` for un-mentioned messages and the manifest.
> Every member can start turns; the `participants` policy (`"owner"`, `"confirm"`) is deferred,
> since eve can't read a forked channel's owner before dispatch. Replies follow the thread the user
> wrote in. Not yet: the membership check, and phase 3.
>
> Phase 2 is in, without `ctx.startInChannel()`: `openCodeChannel(ctx, slack, { message, name })`
> from `eve/channels/slack`, which apps wrap in a tool, over a public `codeChannel` target on the
> Slack channel's `receive()`. Inbound handlers get `ctx.openCodeChannel()`. No signed binding yet.
> Creation sends `origin_channel_id` and `origin_message_ts` and leaves origin eligibility to
> Slack, then confirms a private origin produced a private channel before copying history.

## Summary

[Slack Code](https://docs.slack.dev/ai/slack-code) gives an agent a dedicated channel per task, a
"code channel", with a session status, a context bar, view tabs (diffs, canvases, HTML, Block
Kit), per-channel slash commands, and an archive step that records a summary. Slack's guidance is
that an agent mentioned in an ordinary channel decides for itself when a request needs more than
one message and opens a code channel for it.

eve cannot do this today. The Slack channel keys every session by `channelId:threadTs` and always
replies in a thread. This plan adds code channel support to the existing `slackChannel()` in three
phases:

1. **Serve code channels.** Recognize a code channel, run one session for the whole channel,
   reply top-level, answer without a mention, drive the session status, and honor
   `agent_session_stopped`.
2. **Fork a thread into a code channel.** An `openCodeChannel(ctx, slack, { message, name })`
   helper, which apps wrap in a small tool, lets the model create the code channel from the
   triggering message and start a new eve session there with the thread's conversation as
   `history`. It uses `ctx.to()` for tools from [#5096](https://github.com/vercel/eve/pull/5096)
   and `history` from [#4477](https://github.com/vercel/eve/pull/4477). Apps can also fork from
   inbound handlers.
3. **Code channel surfaces.** Typed helpers for the context bar, views, rename, slash commands,
   and archive.

This plan stacks on #5096. The fork's send carries `ctx.callId` as its idempotency key, so a
retried call reaches the code channel's session once. A message someone posts in the new channel
before the fork's send can still land ahead of the seeded history; closing that needs
`ctx.startInChannel()` with a first message (see [Retries and races](#retries-and-races)).

## Why not a separate channel

An early sketch made code channels a second, opt-in channel file:

```ts title="agent/channels/slack-code.ts"
import { slackCodeChannel } from "eve/channels/slack";

export default slackCodeChannel({ credentials });
```

This plan extends `slackChannel()` instead, for three reasons:

- **One app, one route.** Code channel events come from the same Slack app, with the same
  credentials and manifest, on the same Events API request URL as every other message. Two
  channels would have to split one webhook between them, and each would need to know which
  conversations belong to the other.
- **Forking crosses the boundary.** The fork starts in an ordinary thread and continues in a code
  channel. With two channels, the fork becomes a cross-channel hand-off with two configurations
  that must agree on auth, rendering, and credentials.
- **Most behavior is shared.** Rendering, HITL, task cards, attachments, auth derivation, and
  delivery are the same in both kinds of conversation. Only session keying, reply placement,
  status, and mention handling differ.

## Authoring API

Phase 1 is an option on the Slack channel:

```ts title="agent/channels/slack.ts"
import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
  codeChannels: true,
});
```

The option turns on code channel detection (Slack's `conversations.info`), the manifest additions,
and answers to un-mentioned messages. Those go to `onMessage`, else `onAppMention`, else the
default handler, so an authored mention handler still gates who reaches the agent. Without the
option, eve never looks a channel up and serves a code channel like any other channel.
[Participants](#participants) is deferred; if it lands, `codeChannels` widens to
`true | { participants }`, which keeps `true` valid.

Phase 2 is a helper, `openCodeChannel(ctx, slack, { message, name })` from `eve/channels/slack`. A
channel cannot contribute tools to the agent, so the app wraps the helper in a small tool of its
own (see [Flow](#flow)) and writes the tool's description from Slack's guidance: open a code
channel for multi-step work, code changes, builds, tests, PRs, or long output; reply in place for a
single message answer. The tool passes its own Slack channel, and the helper hands the Slack work
to that channel's `receive()` (see [The code channel target](#the-code-channel-target)).

## Phase 1: serve code channels

### Detection

A code channel reports `properties.record_channel.record_type === "agent_channel"` from
`conversations.info`. Slack writes this at creation, so it is reliable before the session produces
anything. With `codeChannels: true`, eve looks a channel up once per process and caches the
result; channels eve created are cached at creation. A failed lookup is served per thread and
retried a minute later. Without the option, eve never looks a channel up.

### Session keying

A code channel is one session. eve keys it by `slackCodeChannelContinuationToken(channelId)`
(`code:C123`), not by thread, and `SlackSessionTarget` takes `{ channelId, codeChannel: true }`
for it next to `{ channelId, threadTs }`. Every message in the
channel, top-level or threaded, resolves to that session. Slack does not allow separate agent
sessions in a code channel's threads, so this matches Slack's model. The prefix can't collide with
a thread token, which starts with a channel id.

The session has no thread, and nothing user-facing shows a placeholder: `ctx.slack.threadTs` is
empty, `SlackChannelState.threadTs` is `null`, and its Slack auth has no `thread_ts`. One
explicit flag says it's a code channel: `codeChannel` in state, read through `ctx.slack.codeChannel`
in hooks and renderers. The binding skips auto-anchoring, omits `thread_ts`, and reads no thread
history. Approval cards, modals, and sign-in prompts route back with a code channel target, so an
empty thread never stands in for it. The channel's tracing metadata repeats it, unlisted, for eve's own tools.

### Reply placement

The session address and the reply target are separate. The address is `code:C123` for the whole
channel. Each turn has its own reply target: unset (top-level) when the message that started the
turn was top-level, and that message's thread when the person wrote in a thread, following
Slack's "only thread a reply when the user threaded first". A message folded into a running turn
doesn't move that turn's replies; the target is fixed when the turn starts.

The binding's auto-anchor (adopting the first post as the thread root) never runs in a code
channel. Replies go out through `chat.postMessage`
without `thread_ts`, or with the turn's thread. Top-level streaming with `chat.startStream` would
be a new writer, and is not part of this plan.

### Mentions

Slack asks agents to respond in a code channel without a mention. With `codeChannels: true`,
every human message in a code channel goes to `onMessage`, else `onAppMention`, else the default
handler, which treats it as a turn the way it treats DMs. An authored mention handler still gates
who reaches the agent, and `ctx.slack.codeChannel` tells code channel messages apart. Outside a
code channel, such a message falls back to `onEvent`, as any other channel message would.

When Slack creates a code channel from an origin message, it posts a context message into the new
channel that quotes the origin (a block with `block_id: "agent_channel_origin_context"`, with
fallback text that starts `Context from #channel`). The default hook skips it, so it never starts
a turn. The forked session already has the origin conversation as history.

### Participants

Deferred. Phase 1 lets every member start turns, as in an ordinary thread, because eve can't read
a forked channel's owner before dispatch. The design below stays as the plan if it lands.

Code channels admit members of the origin channel, so more people can talk in one than asked for
it. The session's auth comes from whoever started it, so an unrestricted channel lets any member
drive work under the starter's identity. `codeChannels.participants` sets the policy:

| Value       | Behavior                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"owner"`   | Only the person who opened the channel starts turns. Other messages are ignored.                                                                           |
| `"confirm"` | Other members' messages become an approval request to the owner, using eve's existing HITL. A confirmed request runs as a turn; a rejected one is dropped. |
| `"all"`     | Every member starts turns, with auth derived per message as in ordinary threads.                                                                           |

The owner is the person who triggered the fork, or the channel's `creator` for a channel opened
from Slack's UI. eve checks channel membership before admitting a message from a channel it did
not create, because a mention event alone does not prove the speaker can see the channel.

### Session status

eve maps turn lifecycle to `agents.sessions.setStatus` on the channel (no `thread_ts`):

| eve event                                   | Slack status |
| ------------------------------------------- | ------------ |
| `turn.started`                              | `processing` |
| turn settles with nothing pending           | `active`     |
| an input request (question, approval) parks | `suspended`  |

Slack shows its own "Working..." UX while the status is `processing`, so the thread-status line
(`assistant.threads.setStatus`) is not used in code channels. Task cards keep working unchanged.

### Stop

`agent_session_stopped` for a code channel, or for a thread in one, cancels the code channel
session's active turn. A redelivered stop is deduplicated by event ID, so it can't cancel a later
turn. Slack updates the status itself. Suppressing posts that the cancelled turn still sends, and
ending in-progress streams (`streaming_message_ts`), can follow. A stop for a thread in an
ordinary channel is outside this plan.

### Manifest and setup

`defineSlackAppManifest` and `eve add channel/slack` gain an option that adds:

- `features.code_channels.enabled: true` (and `slash_command_url` in phase 3)
- bot scope `code_channels:manage`, plus `channels:history` / `groups:history`
- bot events `message.session` and `agent_session_stopped`

`message.session` delivers messages only from code channels and agent session threads, so an app
gets un-mentioned code channel messages without subscribing to every channel message. Vercel
Connect connectors need the same scopes and events.

## Phase 2: fork a thread into a code channel

### Flow

eve ships the helper, not a tool. Apps wrap it in a tool with their own description and inputs,
and pass their own Slack channel, so an app with two Slack channels picks one:

```ts title="agent/tools/open_code_channel.ts"
import { openCodeChannel } from "eve/channels/slack";
import { defineTool } from "eve/tools";
import { z } from "zod";
import slack from "../channels/slack";

export default defineTool({
  description: "Move this conversation into a new Slack code channel for multi-step work.",
  inputSchema: z.object({ message: z.string(), name: z.string().max(80) }),
  async execute({ message, name }, ctx) {
    return await openCodeChannel(ctx, slack, { message, name });
  },
});
```

1. **Classify.** `ctx.channel.metadata` names the Slack conversation and the triggering message,
   so the channel links to the message that asked for the work, even when it is a thread reply.
   It doesn't depend on the session's auth, so hooks that return their own `auth` keep the tool. A
   code channel session's metadata has `codeChannel: true` from its first turn, so the helper
   refuses to open a code channel from inside one, as Slack asks.
2. **Copy the conversation.** The helper turns `ctx.messages`, the conversation the model saw,
   into text history. Reading the session's own stream from inside a tool misses the current turn.
3. **Start the session.** `ctx.to(slack, { channelId, codeChannel })` runs the Slack channel's
   `receive()`, which opens the channel and starts its session, with `idempotencyKey: ctx.callId`.

### The code channel target

`receive()` takes a `codeChannel: { name, originTs }` target, which can't be combined with
`threadTs` or `initialMessage`. It:

- calls `agents.conversations.create` with `origin_channel_id` and `origin_message_ts`. Slack
  invites the origin message's author, links the channel in the origin thread, gives it the
  origin's privacy, and refuses Slack Connect origins. eve confirms a private origin produced a
  private channel before copying anything;
- passes `session_id`, a digest of the origin channel, origin message, and requester, so one
  requester gets one code channel per message, within Slack's 64 character limit;
- keys the session by `slackCodeChannelContinuationToken(channelId)`, the same address phase 1 uses for
  inbound messages, and moves the origin's auth to the code channel (`channel_id`, no
  `thread_ts`), keeping the principal.

### Retries and races

A retried tool call repeats `ctx.callId`, so it reaches the same channel and session, which gets
the message once. A second call for the same message, with a new call id, delivers the history and
the message again. If someone posts in the new channel before the tool's `send()`, their message
starts the session, and the tool's delivery then adds the history and the model's handoff message
to it. Nothing is lost, but the imported turns land after the person's first message.

`ctx.startInChannel()` would fix the race: whoever claims the address seeds it in the same call that
starts its first turn, and a losing claimant sends its message as a follow-up instead of dropping
it.

A signed channel binding (source session, turn, and owner in `agent_resource`) and discovery for
channels opened from Slack's UI are deferred with it.

### Fork, not move

eve could move the source session into the code channel by aliasing the channel's continuation
token to it. This plan forks instead:

- Slack treats a code channel as one session and the origin thread as a separate conversation.
  Moving the session leaves the thread with no session to answer follow-ups.
- A fork lets the code channel use different defaults (for example a sandbox, a different
  turn policy, or code channel instructions) without affecting the thread.
- #5096 already gives tools a supported fork path. Moving a live session between addresses
  mid-turn has no precedent in eve.

### Without history

Some agents keep their working state outside the eve transcript, for example in an external task
or job that the session drives. For them, the code channel session does not need the thread's
conversation, only a pointer to that state. `history: false` starts the code channel session
with just the first message, and the app carries the pointer in the message or in the binding.
Such apps usually want the `queue` turn policy in the code channel, so later messages line up
behind the running work instead of interrupting it.

### Who decides

Slack's guidance is that the model decides from the request and its context, and that users
should not need a command. That is why phase 2 is a tool the model calls and not an inbound rule.

### Failures

eve retries transient Slack errors (`ratelimited`, `internal_error`, `fatal_error`,
`service_unavailable`, `request_timeout`, `channel_creation_failed`, `invite_failed`,
`open_failed`). Any other error is permanent: the step stops retrying and the tool call fails
with Slack's error, which the model relays while it continues in the thread.

### Channels opened from Slack's UI

Deferred. Today a person can open a code channel from Slack directly and mention the agent in it;
eve serves the channel as one session that starts fresh. The plan: eve first reads a verified
binding. Without one, it reads
`agent_session.origin_link` (`channel_id`, `ts`). The origin message may be a reply, so eve looks
up that message's `thread_ts` and resolves `slackContinuationToken(origin.channel_id, thread_ts)`.
When a source session exists, eve seeds history from it, as in a fork. A channel with no origin,
or an origin with no session, starts fresh.

eve ignores a code channel that is archived, shared outside the workspace, or not assigned to this
app's bot (`agent_session.encoded_agent_bot_user_ids`). The channel's `creator` would be its owner
for [Participants](#participants).

## Forking needs from eve

#4477 adds `history` on `send()` and `create()`. #5096 adds `ctx.to()` and `ctx.channel` to
tools, and the parity change below it gives `to().send()` `history` and `idempotencyKey`. Against
those:

| Need                               | Status                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Channel operations from a tool     | Covered by #5096: `ctx.to()` in tools and workflow steps.                              |
| Read the calling conversation      | Covered: `ctx.channel.metadata` and `ctx.messages`.                                    |
| Retried calls deliver once         | Covered: `idempotencyKey: ctx.callId`.                                                 |
| Race-free first turn               | Needs `ctx.startInChannel()` with a first `message`. Deferred until a caller needs it. |
| Size check against Workflow limits | Needed. See below.                                                                     |
| Tool results as text               | Can follow.                                                                            |
| Lineage (`forkedFrom`)             | Can follow. Not stored until lineage exists, to avoid a second lineage store.          |

**`ctx.startInChannel()`.** `ctx.startInChannel(name, message, { target, auth, history })`
runs `receive()` with a `from()` whose `send()` becomes a `create()` at the same address, and returns
`{ created, sessionId }`. An earlier revision of #5096 had this shape before it was deferred.
`from().create()` gains the same optional first `message`.

**Size check.** #4477 no longer caps history. History travels in the run input, in session state
(when `create()` holds it until the first message), and in the `history.imported` event. The
Workflow payload and event size limits for these are not checked yet, so a very large fork would
fail in the Workflow layer without a clear eve error. eve should check the size up front and fail
with a clear error. A large seeded history is compacted on the first turn, but one larger than
the compaction model's own context window could still fail; the check should account for it. The
tool's `history` option is where apps trim long sessions.

**Tool results as text.** History is text only, so a forked session loses tool calls, which
matters for coding work (files read, commands run, branch names). Until #4477's tool tier lands,
the transcript read can optionally render settled tool calls as short assistant text
(`Ran tool X: <one-line result>`). This is lossy and opt-in.

**Lineage.** A later `forkedFrom: { sessionId, turnId }` on `create()` and `send()` would let
clients, traces, and Agent Runs link the two sessions, with a `session.forked` event on the
source stream.

## Phase 3: code channel surfaces

`ctx.slack.codeChannel` is available when the conversation is a code channel:

```ts
await ctx.slack.codeChannel.setContextBar([
  { key: "repo", label: "acme/billing", icon: "folder", url: "https://github.com/acme/billing" },
  {
    key: "pr",
    label: "PR #42 is open",
    icon: "hierarchy",
    url: "https://github.com/acme/billing/pull/42",
  },
]);
await ctx.slack.codeChannel.setView({
  type: "diff",
  content: diff,
  baseBranch: "main",
  headBranch: "agent/fix",
});
await ctx.slack.codeChannel.rename("Fix flaky login test");
await ctx.slack.codeChannel.archive({ summaryMessageTs });
```

These wrap `agents.conversations.setProperties`, `setView`, `listViews`, `removeView`,
`setCommands`, `archive`, and `agents.sessions.rename`. Context bar items replace the whole set on
each call, so the helper keeps the last set in session state and merges by `key`.

Optional model-facing tools (`set_context_bar`, `publish_diff`, `archive_code_channel`) can follow
once the helpers settle. Archive should stay behind a confirmation, following Slack's suggested
pattern of a summary message plus an archive button.

Per-channel slash commands (`setCommands`) arrive at the manifest's `slash_command_url`. eve
routes them to the existing `onSlashCommand` with the code channel's session target.

## Runtime boundary

- Phase 1 is inside the Slack channel: inbound classification, session keying, binding options,
  default hooks, and renderer defaults. No harness or workflow change.
- Phase 2 adds the Slack `codeChannel` receive target and the `openCodeChannel()` helper. It runs
  on #5096's `ctx.to()`. `ctx.startInChannel()`, with a first message, is the one framework
  addition it would want later, and it is additive.
- Phase 3 is Slack API wrappers and state.

## Non-goals

- Moving a live session between Slack addresses.
- Agent session threads (`agents.sessions.*` with `thread_ts`) in ordinary channels. They share
  the status and stop plumbing from phase 1 and can follow separately.
- Carrying sandbox state into the forked session. The code channel session starts its own
  sandbox.
- Automatic archive when a PR merges. Apps can call `archive` from their own hooks.

## Open questions

1. **Binding secret.** Whether eve derives the binding's signing key from an existing deployment
   secret or asks apps for a dedicated one, and what eve does when neither exists.
2. **Confirmed requests' auth (deferred with participants).** Under `"confirm"`, whether a confirmed request runs as the owner
   (the session's auth) or as the requester. Running as the owner is simpler but lets the owner
   approve work they could not have asked for in the requester's name.
3. **Chat SDK.** eve's Slack transport calls the Web API directly, so this does not depend on the
   Chat SDK Slack adapter. If the adapter adds code channel APIs, eve should match its naming.
4. **Default `history`.** The whole source transcript can be noisy. A model-written handoff brief
   (one assistant message) may serve the code channel better. The `history` option allows either;
   the default needs evaluation.
5. **Stop semantics.** Whether `agent_session_stopped` should cancel only the active turn or also
   pending tasks the turn started.
6. **Ship before `create()`?** Phase 2 works on #5096 with the first-message race described in
   [Retries and races](#retries-and-races). Decide whether to ship it that way first or land
   `ctx.startInChannel()` together with it.

## Validation plan

- Unit: code channel detection and caching; channel-scoped keying for top-level and threaded
  messages; a code channel session omits `thread_ts` and never auto-anchors; Slack's origin context
  message is skipped; status transitions per lifecycle event; `session_id` derivation within 64
  characters; origin eligibility, including Grid DMs marked org-shared; the `unknown_method`
  fallback; permanent error classification; binding signing and rejection of a tampered binding;
  the `codeChannel` receive target maps to `code:C123`.
- Integration, modeled on #5096's `channel-to.integration.test.ts` against the real
  `slackChannel()` with Slack's API mocked: a tool wrapping the helper forks a thread into a code
  channel, the code channel session's first model call sees the thread's history, a later message
  in the code channel reaches only that session, and the source thread keeps answering. `agent_session_stopped` cancels the active turn and
  suppresses later posts.
- Conformance: the Slack conformance suite gains code channel cases (top-level replies, no
  mention required, threaded user replies).
- E2E: a fixture agent forks a thread into a code channel against a mocked Slack API and answers
  the first code channel message from the seeded history.
