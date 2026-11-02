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

This plan keeps routing in the message hooks apps already write, and adds the treatment as a
result flag. It adds no top-level option:

- **`ambient: true`** on a message hook's result tells eve the message may not be addressed to
  the agent.
- **`ctx.isFollowUp()`** tells a hook whether a message is an unmentioned reply in a thread the
  agent already serves.
- **The Slack scaffold** writes an `onMessage` that combines the two, so new apps follow threads
  as readable code.
- **The default edit hook** runs the app's own message hook on an edited message, so writing
  `onMessage` no longer turns off edits.

## Authoring API

One new field on `SlackMentionResult`, the result of `onMessage`, `onAppMention`,
`onDirectMessage`, and `onMessageEdited`:

```ts
return { auth, ambient: true }; // this message may not be addressed to the agent
```

One new method on `SlackInboundMessageContext`, next to `isBotMentioned()`, `isSubscribed()`, and
`isDMOrPrivateChannel()`:

```ts
ctx.isFollowUp(): Promise<boolean>
```

Following threads is an `onMessage` that uses both:

```ts title="agent/channels/slack.ts"
import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
  async onMessage(ctx, message) {
    if (message.author?.isBot !== false) return null;
    const auth = defaultSlackAuth(message, ctx);
    if (ctx.isBotMentioned() || (await ctx.isDMOrPrivateChannel())) return { auth };
    if (await ctx.isFollowUp()) return { auth, ambient: true };
    return null;
  },
});
```

```ts title="agent/tools/no_reply.ts"
import { noReply } from "eve/tools/no_reply";

export default noReply;
```

`ambient` also covers routing that following doesn't, such as letting a decision model choose
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

`ambient` and `isFollowUp()` are `minor` additions to the stable Slack channel API. `no_reply`
stays opt-in and unchanged; eve adds no build warning.

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
quiet turn, so on an edit result `ambient` adds only the guidance: the `<slack_message_edit>`
block gets the same `<reply_guidance>` block.

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

### `ctx.isFollowUp()`

`isFollowUp()` returns `true` when all of these hold:

| Condition                | Why                                                                          |
| ------------------------ | ---------------------------------------------------------------------------- |
| Human author             | Another bot replying would loop.                                             |
| Thread reply             | Top-level messages still need a mention.                                     |
| Not a DM or code channel | Both are already addressed to the agent.                                     |
| No mention of the bot    | A mention arrives as `app_mention`; the `message.*` copy would duplicate it. |
| The thread has a session | The agent joins a thread by being mentioned, never by a stranger's reply.    |

For an edit, "no mention" covers the text before and after the edit, matching
`ctx.isBotMentioned()`. The session check is the same lookup as `isSubscribed()`, and it runs
only when the other conditions hold.

### Routing

Following adds no routing path. An authored `onMessage` receives unmentioned channel messages,
and with `onAppMention` and `onDirectMessage` unset, mentions and DMs too. That is how the
snippet above handles all three. The built-in default for unmentioned channel messages stays
"ignore", and `onEvent` keeps its documented priority over every built-in default.

eve's generated manifest already subscribes to `message.channels` and `message.groups` with
their history scopes, because message edits (#5796) use them. Apps that configure Slack by hand,
or through Vercel Connect, need those subscriptions; without them, `onMessage` receives no
replies. The current docs disagree on whether Connect's defaults include them (`index.mdx` says
to add them; `reference.mdx` says they're included), so the implementation PR confirms and fixes
whichever page is wrong.

### Edits

Today an authored `onAppMention`, `onDirectMessage`, or `onMessage` turns off the default edit
hook, so an app that follows threads by writing `onMessage` silently loses edit steering.

The default edit hook instead runs the message hook a new message of the same kind would reach,
on the edited message:

| Edited message                    | Hook that decides                                       |
| --------------------------------- | ------------------------------------------------------- |
| Mentions the bot, before or after | `onAppMention` → `onMessage` → built-in mention default |
| In a DM                           | `onDirectMessage` → `onMessage` → built-in DM default   |
| In a code channel                 | `onMessage` → `onAppMention` → built-in default         |
| Other                             | `onMessage` → ignore                                    |

The app's own access checks then apply to edits with no extra code. The edit keeps its own
treatment: the `<slack_message_edit>` block, no acknowledgement, no typed answer, and a quiet
turn. If the hook returns `ambient: true`, the edit also gets the reply guidance. With the
snippet above, an edit to a followed reply reaches the session with guidance, and an edit to an
unrelated message is dropped.

An authored `onMessageEdited` still replaces this, and `onEvent` still comes before it, as the
routing table documents. Apps without message hooks see no change: the built-in defaults answer
the same edits that `defaultOnMessageEdited` does today.

### Scaffold

`eve add channel/slack` and the Slack templates write the follow snippet into
`agent/channels/slack.ts` and add `agent/tools/no_reply.ts`. New apps follow threads by default,
as code they can read and edit. Opting out means deleting the `isFollowUp()` line. Existing apps
don't change on upgrade.

## Thread context

`threadContext` exists so the agent sees thread messages it never received. With ambient
messages, its two current behaviors both fail:

- Keep the transcript: every later turn repeats replies the session already received, the whole
  thread with the default `since: "thread-root"`.
- Skip it once the session exists (#5797): the agent never sees replies a hook dropped, other
  bots' replies, or replies from before the app followed threads.

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

- **`threads: { follow: true }`, a built-in hook over `ambient`.** It saves apps about four
  lines, but an authored `onMessage` replaces it, so apps with any custom routing write the check
  anyway. That makes two ways to do one thing on a stable API. The scaffold gives new apps the
  same one-step setup as visible code.
- **Following by default.** The built-in default for unmentioned channel messages would return
  ambient results for follow-ups. eve is at a release candidate, so the default is still cheap to
  change, but on upgrade, side conversations would start reaching model context, session
  history, and traces, and every reply in a followed thread would cost a model call. Apps
  without `no_reply` would rely on the empty-reply fallback. Opting out would mean writing
  mention and DM routing by hand, or adding back an option.
- **A routing path behind `threads.follow` (#5797).** About twice the production code, with the
  treatment reachable only through the boolean. It also put the built-in routes ahead of
  `onEvent`, which let unmentioned replies skip an app's `onEvent` gate.
- **A separate decision model (`decide` in `onMessage`), documented today.** It adds a model call
  per reply and judges from a trimmed transcript rather than the session. With `ambient`, apps
  can still use it to choose which conversations to join.

## Boundaries

- Everything lives in `eve/channels/slack`. No harness, execution, or channel contract changes.
- No new top-level `slackChannel` option.
- Unmentioned channel messages are still ignored without an authored `onMessage`.
- Code channel routing and `onEvent` priority stay as documented.
- `no_reply` stays opt-in, with no build warning.

## Open questions

1. **Name.** `ambient` can read as "ambient listening" rather than a message that may be for
   someone else. Alternatives: `overheard: true`, `addressed: false`, or `quiet: true`, which
   names the mechanism rather than the meaning.
2. **Thread context boundary.** Read the checkpoint in the `deliver` hook, which runs with the
   session's state and can fetch the gap there, or add a session state read to inbound handling?
3. **Group DMs.** `isFollowUp()` is true in group DM threads, which need `message.mpim` and
   `mpim:history`. Apps configured outside eve's manifest may lack them. Document that, or
   return `false` in group DMs?
4. **Engagement decay.** A long-lived thread keeps the agent in forever. Consider ending follow
   after the agent's last reply ages out, or on an explicit signal.
5. **Which templates.** Should every Slack template get the follow snippet, or only the Slack
   agent template and `eve add channel/slack`?

## Validation

- Unit:
  - `isFollowUp()` for each condition, including edits;
  - `ambient` from `onMessage`, `onAppMention`, `onDirectMessage`, and an edit result;
  - an ambient "yes" leaving a pending approval open;
  - the quiet turn across `no_reply`, a real tool, an edit, a mixed turn, and a mention steered
    into a quiet turn;
  - the default edit hook running each row of the edit table, including an authored `onMessage`
    that drops an edit;
  - the `<reply_guidance>` placement, including on an edit.
- Thread context: the checkpoint moving only forward, ignoring edits, and each `since` row.
- Scaffold: `eve add channel/slack` writing the snippet and `no_reply`.
- E2E: a fixture eval where Alice mentions the agent, Bob and Alice talk in the thread and the
  agent calls `no_reply`, then Alice asks a follow-up without a mention and the agent answers.
