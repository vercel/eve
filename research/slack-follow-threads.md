---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: prototype
last_updated: "2026-11-02"
---

# Slack follow threads

> **Implementation status:** Prototype on `barba/slack-natural-threads`. Routing, the model-facing
> reply guidance, quiet turns, the manifest, docs, and unit tests are in. No e2e eval yet.

## Summary

A Slack agent today must be mentioned on every message, even in a thread it already serves. That
reads as a bot, not a participant. eve already offers two workarounds, and both have gaps:

- `onMessage` with `ctx.isSubscribed()` sends every reply, but the model doesn't know a reply may
  not be for it, and every reply flashes `Thinking...` in the thread.
- `onMessage` with `decide` gates replies with a second model that sees a trimmed transcript, not
  the session. It adds a model call per reply and duplicates the agent's own judgment.

This plan makes "once in a thread, stay in it" a one-line opt-in. The agent's own model decides
whether to answer and uses `no_reply` to stay quiet. eve adjusts the prompt and the thread status
so a skipped reply leaves no trace.

## Authoring API

```ts title="agent/channels/slack.ts"
export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
  threads: { follow: true },
});
```

```ts title="agent/tools/no_reply.ts"
import { noReply } from "eve/tools/no_reply";

export default noReply;
```

`threads?: SlackThreadsOptions` with `follow?: boolean`, default `false`. The object leaves room
for later thread behavior without more top-level options. It ships stable, as a `minor` addition.

`no_reply` stays opt-in and unchanged: channels don't add tools, and eve doesn't warn or change
the build when `threads.follow` is on without it. The docs tell authors to add it. Without it, the
guidance tells the model to end its turn with no text, which root sessions accept.

## Semantics

**Which messages follow.** A message is a follow-up when all of these hold:

| Condition             | Why                                                                       |
| --------------------- | ------------------------------------------------------------------------- |
| Human author          | Another bot replying would loop.                                          |
| Thread reply, not DM  | Top-level messages still need a mention; DMs are already addressed.       |
| No mention of the bot | A mention arrives as `app_mention`; the `message.*` copy would duplicate. |
| Thread has a session  | The agent joins a thread by being mentioned, never by a stranger's reply. |
| Not a code channel    | A code channel already answers every message as one session.              |

The session check needs a lookup, so it runs after Slack's ack, inside dispatch.

**Hook precedence** matches `codeChannels`: authored `onMessage`, else `onAppMention` with
`ctx.isBotMentioned() === false`, else the default handler. Auth gating stays in one place. With
`onMessage` authored, `threads.follow` still applies its prompt and status treatment to any
unmentioned reply that hook sends to an existing session.

**Prompt.** A follow-up's `<slack_message>` gains a `<reply_guidance>` block between `<thread>`
and `<content>`. Mentions and DMs never carry it.

```text
<reply_guidance>
You are part of this Slack thread, so every reply in it reaches you, including messages people
send each other. Several people may share the thread, and <sender> names who wrote this one.
This message does not mention you. Reply when it is meant for you: a question or request you can
help with, or a follow-up to something you said or did.
When people are talking among themselves, acknowledging each other, or someone else is better
placed to answer, stay out of it: call `no_reply` instead of replying, or end your turn without
text if you have no `no_reply` tool.
</reply_guidance>
```

The guidance rides on the message, not the system prompt, because:

- It is true per message (`mentioned: false`), not per session: the same thread mixes mentions
  and ambient replies.
- It survives compaction and history seeding with the message it describes.
- Channels have no system-prompt hook, and adding one to the core for this would widen
  `harness/` for one channel.

**Quiet turns.** A follow-up gets no `received` acknowledgement. A turn whose every message is a
follow-up starts quiet: the default renderer shows no thread status until the model calls a tool
other than `no_reply`. A mention or DM folded into the turn makes it loud. `turn.settled` resets
both flags. Authored renderers that call `thread.startTyping` themselves are unaffected.

```text
deliver(followUp) ─┐
deliver(followUp) ─┼─ pendingQuietTurn = true ─▶ turn.started: quietStatus = true
deliver(mention)  ─┘  (any non-follow-up → false)        │
                                    call.requested(tool ≠ no_reply) ─▶ quietStatus = null
                                                turn.settled ─▶ both reset
```

**Manifest.** Adds `message.channels`, `message.groups`, `channels:history`, and
`groups:history`, deduplicated against `codeChannels`.

**Turn policy.** Follow-ups that arrive mid-turn follow `turnPolicy` like any message. Under
`"steer"`, chatter steers a running turn; the guidance tells the model it may not need to change
course.

The quiet stamp is correct under both policies because the runtime runs the channel's `deliver`
hook in the step that admits a message, not when Slack's webhook arrives:

- `"queue"`: messages held during turn A are admitted in the step that starts turn B, after A's
  `turn.settled`. `pendingQuietTurn` reflects exactly B's messages when B's `turn.started` reads it.
- `"steer"`: messages admitted into running turn A set `pendingQuietTurn`, but no `turn.started`
  follows. A's `turn.settled` clears it, so it never leaks into the next turn.

## Boundaries

- No new tool, and no change to `no_reply` or `endsTurn`.
- No change to the harness, execution, or the channel contract. Everything lives in
  `eve/channels/slack`.
- A top-level message in a channel never follows: joining requires a mention.

## Decisions

- Name: `threads: { follow: true }`.
- Stability: stable, `minor`.
- Missing `no_reply`: documented only. No warning and no build change.
- Queued turns: no change needed; see [Semantics](#semantics).
- `threadContext`: in a followed channel thread, it only seeds history when a message starts the
  session. Without this, every later turn would re-send replies the session already received, the
  whole thread with the default `since: "thread-root"`. The one loss is other bots' replies, which
  following doesn't deliver. DMs and code channels keep their transcript.
- `onEvent`: code channels and following both take precedence over it, whether or not
  `onAppMention` is authored. `onEvent` still gets every message they don't serve. Before this,
  the built-in code channel route lost to `onEvent`, so adding `onEvent` without `onAppMention`
  silently turned code channels off. That change ships as its own `patch` changeset.

## Open questions

1. **Message edits.** The in-flight `onMessageEdited` work has its own `pendingEditTurn` and
   `quietStatus`. Both should share one "quiet turn" stamp so an edit and a follow-up compose.
2. **Engagement decay.** A long-lived thread keeps the agent in forever. Consider ending follow
   after the agent's last reply ages out, or after an explicit "stop following" signal.

## Validation

- Unit: routing (follow-up sent; no session, bot, top-level, and mention copy ignored), quiet
  status across `no_reply`, a real tool, and a mixed turn, the `<reply_guidance>` placement, and
  manifest scopes.
- E2E (to add): a fixture eval where Alice mentions the agent, Bob and Alice chat in the thread,
  and the agent calls `no_reply`, then answers Alice's unmentioned follow-up question.
