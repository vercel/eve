---
issue: TBD
status: proposed
last_updated: "2026-10-20"
---

# Slack code channels

> **AI status:** Written entirely by AI; human review pending.

## Summary

[Slack Code](https://docs.slack.dev/ai/slack-code) gives an agent a dedicated channel per task, a
"code channel", with a session status, a context bar, view tabs (diffs, canvases, HTML, Block
Kit), per-channel slash commands, and an archive step that records a summary. Slack's guidance is
that an agent mentioned in an ordinary channel decides for itself when a request needs more than
one message and opens a code channel for it.

eve cannot do this today. The Slack channel keys every session by `channelId:threadTs`, always
replies in a thread, and has no way to start a second session that carries the first one's
conversation. This plan adds code channel support to the existing `slackChannel()` in three
phases:

1. **Serve code channels.** Recognize a code channel, run one session for the whole channel,
   reply top-level, answer without a mention, drive the session status, and honor
   `agent_session_stopped`.
2. **Fork a thread into a code channel.** A Slack helper creates the code channel from the
   triggering message and starts a new eve session there, seeded with the thread's conversation
   through the `history` option and `create()` from
   [#4477](https://github.com/vercel/eve/pull/4477). The agent decides when to fork through an
   opt-in tool; apps can also fork from their own code.
3. **Code channel surfaces.** Typed helpers for the context bar, views, rename, slash commands,
   and archive.

This plan stacks on #4477 and proposes the additions to it that forking needs (see
[Forking needs from session history](#forking-needs-from-session-history)).

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

```ts title="agent/channels/slack.ts"
import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
  codeChannels: {
    // Expose a model-facing tool that forks the current thread into a code channel.
    // Defaults to false: apps opt in to model-driven forking.
    tool: true,

    // Optional. Decides deterministically whether an inbound mention forks before any turn
    // runs. Return null to let the turn run in place.
    async shouldOpen(ctx, message) {
      return null;
    },

    // Optional. Shapes what the code channel session starts from. Defaults to the source
    // session's transcript, trimmed to the history caps.
    async history(ctx, source) {
      return source.history;
    },
  },
});
```

Omitting `codeChannels` keeps today's behavior, except that a mention inside a code channel that a
person opened from Slack's UI is still served as a code channel (phase 1 needs no opt-in once the
app has the feature enabled).

Apps fork from their own code with a Slack helper that is available on inbound and event
contexts:

```ts
const result = await ctx.slack.openCodeChannel({
  name: "Fix the flaky login test",
  // Defaults to the session that owns the current thread.
  history: "source",
  message: "Continue the task from the thread. Start by reproducing the failure.",
});

if (result.status === "opened") {
  // result.channelId, result.session
} else {
  // "ineligible" (shared or Slack Connect origin) or "unavailable" (feature disabled,
  // missing scope, permanent Slack error). The caller replies in place.
}
```

## Phase 1: serve code channels

### Detection

A code channel reports `properties.record_channel.record_type === "agent_channel"` from
`conversations.info`. Slack writes this at creation, so it is reliable before the session produces
anything. eve checks it once per conversation the first time a message arrives without a known
session, and stores the result in session state (`kind: "code_channel"`). Channels eve created
itself are marked at creation and skip the lookup.

### Session keying

A code channel is one session. eve keys it by `slackContinuationToken(channelId, "")`
(`C123:`), not by thread. Every message in the channel, top-level or threaded, resolves to that
session. Slack does not allow separate agent sessions in a code channel's threads, so this matches
Slack's model.

### Reply placement

eve replies top-level in a code channel. A threaded user message gets its reply in that thread.

Today, a binding that starts without a `threadTs` adopts the first posted message as the thread
root (`onThreadTsChanged`), so every later reply would land in that thread. Code channel state
disables that auto-anchor. Streaming uses `chat.startStream` without `thread_ts`, which Slack
supports for top-level messages in code channels.

### Mentions

Slack asks agents to respond in a code channel without a mention. The default message hook treats
every human message in a code channel as a turn, the same way it treats DMs today. An authored
`onMessage` keeps full control. A new `ctx.isCodeChannel()` helper joins `isDMOrPrivateChannel()`
and `isSubscribed()`.

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

`agent_session_stopped` without `thread_ts` cancels the code channel session's active turn and
suppresses further posts and `agents.*` calls for that turn, as Slack requires. Slack updates the
status itself. The same event with a `thread_ts` in an ordinary channel can cancel that thread's
session once eve adopts thread agent sessions; that is outside this plan.

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

1. **Decide.** The model calls the `open_code_channel` tool, `shouldOpen` returns a target, or
   app code calls `ctx.slack.openCodeChannel()`.
2. **Check the origin.** Shared and Slack Connect origins may include people outside the
   workspace. eve does not fork them and returns `ineligible`.
3. **Create.** eve calls `agents.conversations.create` with the origin channel, the triggering
   message `ts`, and a `session_id`. Slack treats `session_id` as an idempotency key (at most 64
   characters), so eve derives it from the source session id and the triggering message: webhook
   retries and step replays return the same channel.
4. **Seed.** eve builds history from the source session and calls
   `from(slackContinuationToken(channelId, "")).create({ auth, history, state })`. `create()`
   returns `created: false` when a retry already seeded the channel, so seeding is idempotent too.
5. **Start.** eve sends the first message to the new session: the tool's `message` argument, or
   the triggering message for `shouldOpen`.
6. **Point back.** The source session's tool call returns the new channel, and the model's reply
   in the thread links to it. The source thread stays a normal session for quick questions.

### Fork, not move

eve could move the source session into the code channel by aliasing the channel's continuation
token to it. This plan forks instead:

- Slack treats a code channel as one session and the origin thread as a separate conversation.
  Moving the session leaves the thread with no session to answer follow-ups.
- A fork lets the code channel use different defaults (for example a sandbox, a different
  turn policy, or code channel instructions) without affecting the thread.
- `create({ history })` already gives forking a supported, idempotent path. Moving a live session
  between addresses mid-turn has no precedent in eve.

### Who decides

Slack's guidance is that the model decides from the request and its context, and that users
should not need a command. The `open_code_channel` tool is exposed only when all of these hold,
using dynamic tool resolution on the Slack channel's metadata:

- `codeChannels.tool` is enabled
- the conversation is a Slack thread or DM, not a code channel
- the installation has code channels enabled (the last create did not return a permanent error)

eve ships default tool instructions adapted from Slack's guidance: open a code channel for
multi-step work, code changes, builds, tests, PRs, or long output; reply in place for a single
message answer.

### Failures

These Slack errors are permanent for the installation or origin, and `openCodeChannel` returns
`unavailable` without retrying: `feature_disabled`, `invalid_agent`, `invalid_origin_link`,
`missing_scope`, `not_allowed_token_type`, `origin_channel_externally_shared`,
`origin_channel_is_file_channel`, `restricted_action`, `unknown_method`, `user_not_enabled`.
Other errors are retried by the step. When the tool returns `unavailable` or `ineligible`, the
model continues in place.

### Channels opened from Slack's UI

A person can open a code channel from Slack directly, then mention the agent in it. eve detects
the channel, reads `agent_session.origin_link`, and resolves the origin's session from the
recorded fork, or from `slackContinuationToken(origin.channel_id, origin.ts)`. When a source
session exists, eve seeds history from it as in a fork. A channel with no origin, or an origin
with no session, starts fresh.

eve records each fork's origin (`origin channel + ts -> source session id`) before calling
Slack, so a code channel created from a reply, where the origin `ts` is not the thread root, still
resolves its source session.

## Forking needs from session history

[#4477](https://github.com/vercel/eve/pull/4477) adds `history` on `send()` and `create()`, and
lists reading or forking sessions as a non-goal. Forking from a running turn needs the following
additions. Each is small and useful outside Slack.

1. **A history reader.** Every fork repeats the same loop: attach to the source session's
   stream, fold `transcriptReducer()`, and stop at a turn boundary. Add
   `sessionHistory(sessionId, { through?: turnId, before?: turnId })` to `eve/server`, returning
   `SessionHistoryMessage[]` already trimmed to the caps.
2. **Forking from inside a turn.** The tool call runs inside the source session's active turn. The
   reader must include that turn's user message and any settled assistant text, and exclude the
   in-flight tool call. `through: currentTurnId` with "settled text only" semantics covers it.
3. **Cap-aware trimming.** Coding threads can exceed 500 messages or 512 KiB. When the transcript
   is over the caps, keep the newest messages that fit, and prepend the latest compaction summary
   when one exists so earlier context is not lost silently. Return what was dropped so the
   caller can say so.
4. **Tool results as text.** History is text only, so a forked session loses tool calls, which
   matters for coding work (files read, commands run, branch names). Until #4477's tool tier
   lands, the reader can optionally render settled tool calls as short assistant text
   (`Ran tool X: <one-line result>`). This is lossy and opt-in.
5. **Lineage.** `create()` accepts `forkedFrom: { sessionId, turnId }`. eve stores it on the new
   session and publishes it in session metadata, so clients, traces, and Agent Runs can link the
   two sessions. The source session's stream gets a `session.forked` event naming the new session.

Items 1 to 3 are required for phase 2. Items 4 and 5 can follow.

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
- Phase 2 adds the Slack helper and tool, and the `sessionHistory` reader in `eve/server`. It
  uses `create()` from #4477 for seeding. Lineage adds one optional `create()` field and one
  stream event, which bumps the channel and client extension epochs additively.
- Phase 3 is Slack API wrappers and state.

## Non-goals

- Moving a live session between Slack addresses.
- Agent session threads (`agents.sessions.*` with `thread_ts`) in ordinary channels. They share
  the status and stop plumbing from phase 1 and can follow separately.
- Carrying sandbox state into the forked session. The code channel session starts its own
  sandbox.
- Automatic archive when a PR merges. Apps can call `archive` from their own hooks.

## Open questions

1. **Method name.** Slack documents `agents.conversations.create`. At least one existing
   integration calls `codeChannels.create`. Confirm which name is generally available before
   implementing.
2. **Auth for the forked session.** The default reuses the triggering message's auth. Code
   channels can gain members from the origin channel, so apps that scope auth per user may want
   the channel's auth derived per message instead, as in ordinary threads.
3. **Chat SDK.** eve's Slack transport calls the Web API directly, so this does not depend on the
   Chat SDK Slack adapter. If the adapter adds code channel APIs, eve should match its naming.
4. **Default `history`.** The whole source transcript can be noisy. A model-written handoff brief
   (one assistant message) may serve the code channel better. The `history` hook allows either;
   the default needs evaluation.
5. **Stop semantics.** Whether `agent_session_stopped` should cancel only the active turn or also
   pending tasks the turn started.

## Validation plan

- Unit: code channel detection and caching; channel-scoped keying for top-level and threaded
  messages; auto-anchor disabled in code channels; status transitions per lifecycle event;
  `session_id` derivation within 64 characters; permanent error classification.
- Integration: a fork from a thread seeds the code channel session with the thread's history,
  retries return the same channel and `created: false`, and the source thread keeps answering;
  `agent_session_stopped` cancels the active turn and suppresses later posts.
- Conformance: the Slack conformance suite gains code channel cases (top-level replies, no
  mention required, threaded user replies).
- E2E: a fixture agent forks a thread into a code channel against a mocked Slack API and answers
  the first code channel message from the seeded history.
