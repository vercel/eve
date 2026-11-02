---
issue: "None (maintainer proposal; supersedes PR #5797)"
status: proposed
last_updated: "2026-11-02"
---

# Slack ambient messages

> Design by @benpankow, from his
> [review of #5797](https://github.com/vercel/eve/pull/5797#issuecomment-6584564412).

## Summary

A Slack agent must be mentioned on every message, even in a thread it already serves, so it
reads as a bot rather than a participant. Apps can route unmentioned replies to the agent today
with `onMessage` and `ctx.isSubscribed()`. But the model can't tell that a reply may be meant for
someone else, and every reply flashes `Thinking...` in the thread.

#5797 fixed this with a dedicated routing path behind `threads: { follow: true }`. That fused two
concerns: which messages reach the agent, and how eve treats a message that may not be for it.
Only the boolean could reach the second.

This plan splits them. A message hook marks a message as ambient on its result, and eve treats
it accordingly. `threads: { follow: true }` becomes a small built-in hook over that flag.

## Authoring API

One new field on `SlackMentionResult`, the result of `onMessage`, `onAppMention`,
`onDirectMessage`, and `onMessageEdited`:

```ts
return { auth, ambient: true }; // this message may not be addressed to the agent
```

`threads: { follow: true }` keeps the agent in threads it already serves:

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

An app can write the same behavior itself:

```ts
async onMessage(ctx, message) {
  if (message.author?.isBot !== false) return null;
  const auth = defaultSlackAuth(message, ctx);
  if (ctx.isBotMentioned() || (await ctx.isDMOrPrivateChannel())) return { auth };
  if (message.threadTs === message.ts || !(await ctx.isSubscribed())) return null;
  return { auth, ambient: true };
}
```

The flag also covers cases `threads.follow` doesn't, such as letting a decision model choose
which top-level conversations to join:

```ts
async onMessage(ctx, message) {
  if (message.author?.isBot !== false) return null;
  const auth = defaultSlackAuth(message, ctx);
  if (ctx.isBotMentioned() || (await ctx.isDMOrPrivateChannel())) return { auth };
  const result = await decide({
    state: { latestMessage: message.text },
    questions: {
      respond: {
        type: "choice",
        instructions: "Decide whether the agent should join this conversation.",
        criteria: { ignore: "Not relevant to the agent", respond: "Asks for help the agent can give" },
      },
    },
  });
  return result.answers.respond.choice === "respond" ? { auth, ambient: true } : null;
}
```

Both `ambient` and `threads` are `minor` additions to the stable Slack channel API. `no_reply`
stays opt-in and unchanged. The docs tell authors to add it; eve adds no build warning.

## Semantics

### What `ambient` does

| Effect             | Behavior                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| No acknowledgement | eve skips the `received` renderer, so no `Thinking...` appears.                                     |
| No typed answer    | The message never answers a pending approval or question, as edits don't today.                     |
| Reply guidance     | The message's `<slack_message>` block gets a `<reply_guidance>` block (below).                      |
| Quiet turn         | A turn whose every message is ambient or an edit shows no thread status until a tool call finishes. |

Without the typed-answer rule, Bob saying "yes" to Alice in a followed thread could approve the
agent's pending request.

eve acknowledges mentions and DMs before their hook runs, so `ambient` on an `onAppMention` or
`onDirectMessage` result can't take back the `Thinking...` that's already showing. Those results
still get the other three effects. Edits already get no acknowledgement, no typed answer, and a
quiet turn, so on an `onMessageEdited` result `ambient` adds only the guidance: the
`<slack_message_edit>` block gets the same `<reply_guidance>` block.

The guidance rides on the message, not the system prompt. It is true per message, it stays with
the message through compaction, and channels have no system prompt hook:

```text
<reply_guidance>
This message may be meant for someone else in the conversation. Several people may be talking,
and <sender> names who wrote this one. Reply when it is meant for you: a question or request you
can help with, or a follow-up to something you said or did. When people are talking among
themselves, acknowledging each other, or someone else is better placed to answer, stay out of
it: call `no_reply` instead of replying, or end your turn without text if you have no `no_reply`
tool.
</reply_guidance>
```

### Quiet turns

Edits (#5796) and ambient messages share one quiet turn. #5796's `edit` and `pendingEditTurn`
become `quiet` and `pendingQuietTurn`:

```text
deliver(quiet)  ─┐
deliver(quiet)  ─┼─ pendingQuietTurn = true ─▶ turn.started: quietStatus = true
deliver(other)  ─┘  (any other message → false)       │
                                      call.settled ─▶ quietStatus = null
                                      turn.settled ─▶ both reset
```

`no_reply` reports no label, so its call finishing shows nothing before the turn ends. A
message that isn't quiet and joins a running quiet turn under `turnPolicy: "steer"` also clears
`quietStatus`. Without that, a mention steered into a quiet turn stays hidden.

The pending flag is correct under both turn policies. The runtime runs the channel's `deliver`
hook in the step that admits a message, not when Slack's webhook arrives. Queued messages are
admitted in the step that starts the next turn, after the previous `turn.settled`. Steered
messages join the running turn, whose `turn.settled` clears the flag.

### `threads: { follow: true }`

`threads.follow` is a built-in hook that returns an ambient result for a reply when all of these
hold:

| Condition              | Why                                                                          |
| ---------------------- | ---------------------------------------------------------------------------- |
| Human author           | Another bot replying would loop.                                             |
| Thread reply, not a DM | Top-level messages still need a mention. DMs are already addressed.          |
| No mention of the bot  | A mention arrives as `app_mention`; the `message.*` copy would duplicate it. |
| `ctx.isSubscribed()`   | The agent joins a thread by being mentioned, never by a stranger's reply.    |

It calls `onAppMention ?? defaultOnMessage`, so an authored mention hook still gates who can
reach the agent, and returns that result with `ambient: true`. A `null` result drops the reply.

That widens `onAppMention`'s contract: its JSDoc says it runs only for `app_mention` events. The
routing table already shows it receiving unmentioned code channel messages, where
`ctx.isBotMentioned()` returns `false`. A followed thread reply joins that case, and the JSDoc,
the reference page, and the table's new row say so:

| Incoming event                     | Handler order                                                           |
| ---------------------------------- | ----------------------------------------------------------------------- |
| Un-mentioned followed thread reply | `onMessage` → `onEvent` → `onAppMention` → built-in default (`ambient`) |

An existing `onAppMention` that returns `title`, `history`, or `context` for every message gets
them applied to follow-ups too. The docs call that out, and an app can check
`ctx.isBotMentioned()` to tell the two apart.

Like other built-in defaults, an authored `onMessage` or `onEvent` replaces it. `onEvent` keeps
its documented priority over every built-in default, so it stays the gate for apps that use it.
Apps that write `onMessage` return `ambient: true` themselves.

eve's generated manifest already subscribes to `message.channels` and `message.groups` with
their history scopes, because message edits (#5796) use them. Apps that configure Slack by hand,
or through Vercel Connect, need those subscriptions; without them, `threads.follow` receives no
replies. The current docs disagree on whether Connect's defaults include them
(`index.mdx` says to add them; `reference.mdx` says they're included), so the implementation PR
confirms and fixes whichever page is wrong.

## Thread context

`threadContext` exists so the agent sees thread messages it never received. With ambient
messages, its two current behaviors both fail:

- Keep the transcript: every later turn repeats replies the session already received, the whole
  thread with the default `since: "thread-root"`.
- Skip it once the session exists (#5797): the agent never sees replies a hook dropped, other
  bots' replies, or replies from before following was turned on.

The correct rule is that the session sees each thread message once. eve keeps a checkpoint: the
newest Slack `ts` among new messages the session received. `threadContext` then loads only the
replies after the checkpoint and before the new message. That also improves mention-only apps,
where `since: "last-agent-reply"` approximates the same boundary.

The checkpoint can't reuse `state.triggeringMessageTs`, which records the latest delivered
message. An edit keeps its original `ts`, so editing an older reply would move it backward and
repeat replies. The checkpoint only moves forward, and edits don't move it.

The checkpoint changes published `since` semantics, so it combines with them explicitly:

| `since`                   | With a checkpoint                                                |
| ------------------------- | ---------------------------------------------------------------- |
| `"thread-root"` (default) | Replies after the checkpoint, or every prior reply without one.  |
| `"last-agent-reply"`      | Replies after the later of the checkpoint and the agent's reply. |
| A predicate               | Replies after the later of the checkpoint and the last match.    |

`"thread-root"` is documented as every prior message, so the reference page changes with it. A
new message that starts the session has no checkpoint and keeps today's behavior, seeding
history.

This can ship separately. Until it does, ambient messages leave `threadContext` unchanged.

## Alternatives considered

- **A routing path behind `threads.follow` (#5797).** It shipped the same behavior with about
  twice the production code, and its treatment was reachable only through the boolean. It also
  put the built-in routes ahead of `onEvent`, which let unmentioned replies skip an app's
  `onEvent` gate.
- **A separate decision model (`decide` in `onMessage`), documented today.** It adds a model call
  per reply and judges from a trimmed transcript rather than the session. With `ambient`, apps
  can still use it to choose which conversations to join.

## Boundaries

- Everything lives in `eve/channels/slack`. No harness, execution, or channel contract changes.
- Code channel routing and `onEvent` priority stay as documented.
- `no_reply` stays opt-in, with no build warning.
- A top-level channel message never follows without a mention.

## Open questions

1. **Name.** `ambient` can read as "ambient listening" rather than a message that may be for
   someone else. Alternatives: `overheard: true`, `addressed: false`, or `quiet: true`, which
   names the mechanism rather than the meaning.
2. **Composition with `onMessage`.** An authored `onMessage` replaces `threads.follow`. Should
   eve export the follow check as a helper, such as `isFollowUp(ctx, message)`, so an app can
   keep it while handling other messages?
3. **Thread context boundary.** Read the boundary in the `deliver` hook, which runs with the
   session's state and can fetch the gap there, or add a session state read to inbound handling?
4. **Group DMs.** Following applies to group DM threads, which need `message.mpim` and
   `mpim:history`. Apps configured outside eve's manifest may lack them. Document that, or
   exclude group DMs?
5. **Edits in followed threads.** The default `onMessageEdited` only sends edits to messages
   addressed to the agent. Should an edit to an ambient reply in a followed thread reach the
   session too?
6. **Engagement decay.** A long-lived thread keeps the agent in forever. Consider ending follow
   after the agent's last reply ages out, or on an explicit signal.
7. **Cost per reply.** With `threads.follow`, every human thread reply in channels the bot is in
   triggers a session lookup.
8. **Default for new apps.** Should `eve add channel/slack` scaffold `threads: { follow: true }`
   and the `no_reply` tool? @benpankow suggested it.

## Validation

- Unit: the follow hook's conditions; `onAppMention` gating with `isBotMentioned()` returning
  `false`, and `null` dropping the reply; an authored `onMessage` or `onEvent` replacing the hook;
  `ambient` from a hand-written `onMessage`; an ambient "yes" leaving a pending approval open; the
  quiet turn across `no_reply`, a real tool, an edit, a mixed turn, and a mention steered into a
  quiet turn; the `<reply_guidance>` placement, including on an edit.
- Thread context: the checkpoint moving only forward, ignoring edits, and each `since` row.
- E2E: a fixture eval where Alice mentions the agent, Bob and Alice talk in the thread and the
  agent calls `no_reply`, then Alice asks a follow-up without a mention and the agent answers.
