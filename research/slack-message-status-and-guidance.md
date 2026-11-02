---
issue: "None (maintainer proposal; supersedes PR #5797)"
status: in-progress
last_updated: "2026-11-02"
---

# Slack message status and guidance

> Builds on @benpankow's
> [review of #5797](https://github.com/vercel/eve/pull/5797#issuecomment-6584564412): put the
> behavior on the message hook's result, not behind a routing option.

## Implementation status

Everything except [Thread context](#thread-context) is implemented: `status`, `guidance`, the shared
quiet turn, the steer fix, edit delegation, docs, and unit tests. The thread context checkpoint
ships separately. The implementation differs from this plan in these ways:

- **Edit table order.** A DM edit takes the DM row even when it mentions the bot, matching new DMs,
  which always reach `onDirectMessage` first.
- **`ctx.edit`.** Message hooks also decide edits, so `SlackInboundMessageContext` gained
  `edit?: SlackMessageEdit`, set only while a hook decides an edit. Hooks with side effects, such
  as `ctx.send()`, `ctx.end()`, or a `decide` call, check it so an edit doesn't repeat them.
- **Block tags.** The mrkdwn conversion decodes Slack's `&lt;`, so message text could close
  `<content>` and forge `<guidance>`. eve encodes the `<` of its own block tags in content, diff lines, profile fields,
  and guidance, and skips blank guidance.
- **Delivery stamp.** Edits and deferred messages carry one `quiet` stamp; the `edit` stamp is gone,
  because nothing else read it.
- **Decision model example.** The docs limit `decide` to channels the app lists, so unmentioned
  traffic elsewhere costs no decision call.
- **Vercel Connect subscriptions.** The two docs pages still disagree on Connect's defaults. That
  stays open until someone can check a Connect connector.
- **Validation.** Batching keeps guidance per message by construction, because guidance is part of
  each message's text, so it has no test of its own. The E2E eval is a follow-up: no Slack E2E
  fixture exists yet.

## Summary

A Slack agent must be mentioned on every message, even in a thread it already serves, so it
reads as a bot rather than a participant. Apps can route unmentioned replies to the agent today
with `onMessage` and `ctx.isSubscribed()`. But every routed reply flashes `Thinking...` in the
thread, and the model can't tell that a reply may be meant for someone else.

#5797 fixed this with a dedicated routing path behind `threads: { follow: true }`. This plan
keeps routing in the message hooks apps already write, and adds two props to the hook's result:

- **`status`** chooses when eve shows that the agent is working: right away, or only once a tool
  call finishes.
- **`guidance`** adds app-written text to that one message, telling the model how to treat it.

With these, following a thread is a few documented lines of `onMessage`, and the agent decides
whether to reply, calling `no_reply` when it shouldn't. The default edit hook also changes, so
writing `onMessage` no longer turns off edits. There is no new top-level option and no generated
code: the docs describe the pattern, and an app's author or coding agent writes it.

## Authoring API

Two optional props on `SlackMentionResult`, the result of `onMessage`, `onAppMention`,
`onDirectMessage`, and `onMessageEdited`:

```ts
return {
  auth,
  status: "deferred", // "immediate" (default) | "deferred"
  guidance: "This reply may be meant for someone else. Answer only if it's for you.",
};
```

Following threads the agent already serves, with the opt-in `no_reply` tool:

```ts title="agent/channels/slack.ts"
import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
  async onMessage(ctx, message) {
    if (message.author?.isBot !== false) return null;
    const auth = defaultSlackAuth(message, ctx);
    const isDirectMessage = message.raw.channel_type === "im";
    if (ctx.isBotMentioned() || ctx.slack.codeChannel || isDirectMessage) return { auth };
    if (message.threadTs !== message.ts && (await ctx.isSubscribed())) {
      return {
        auth,
        status: "deferred",
        guidance:
          "You are part of this Slack thread, so you see replies people send each other. This " +
          "reply doesn't mention you. Answer only if it's meant for you; otherwise call `no_reply`.",
      };
    }
    return null;
  },
});
```

```ts title="agent/tools/no_reply.ts"
import { noReply } from "eve/tools/no_reply";

export default noReply;
```

An authored `onMessage` also receives mentions and DMs when `onAppMention` and
`onDirectMessage` aren't set, so it answers those first. Code channel messages are addressed to
the agent, too. The DM check reads `channel_type` instead of calling `ctx.isDMOrPrivateChannel()`,
which is also `true` for private channels and would treat every private channel message as
addressed.

`status` and `guidance` are `minor` additions to the stable Slack channel API. `no_reply` stays
opt-in and unchanged, with no build warning.

## Semantics

### `status`

| Value                   | Behavior                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `"immediate"` (default) | Today's behavior: the `received` renderer shows `Thinking...`, and the default renderer shows status through the turn.          |
| `"deferred"`            | No `received` acknowledgement, and no thread status until a tool call finishes. A turn that ends with `no_reply` shows nothing. |

`"deferred"` uses the quiet turn that message edits (#5796) introduced. #5796's `edit` and
`pendingEditTurn` become `quiet` and `pendingQuietTurn`, shared by edits and deferred messages:

```text
deliver(quiet)  ─┐
deliver(quiet)  ─┼─ pendingQuietTurn = true ─▶ turn.started: quietStatus = true
deliver(other)  ─┘  (any other message → false)       │
                                      call.settled ─▶ quietStatus = null
                                      turn.settled ─▶ both reset
```

- **`no_reply`** reports no label, so its call finishing shows nothing before the turn ends.
- **A message that isn't quiet** and joins a running quiet turn under `turnPolicy: "steer"`
  clears `quietStatus`. Without that, a mention steered into a quiet turn stays hidden.
- **Turn policies.** The pending flag is correct under both. The runtime runs the channel's
  `deliver` hook in the step that admits a message, not when Slack's webhook arrives. Queued
  messages are admitted in the step that starts the next turn, after the previous `turn.settled`.
  Steered messages join the running turn, whose `turn.settled` clears the flag.
- **Mentions and DMs** are acknowledged before their hook runs. `"deferred"` on an `onAppMention`
  or `onDirectMessage` result keeps the turn quiet but can't take back the `Thinking...` already
  showing.
- **Edits** are always deferred. `status` on an `onMessageEdited` result has no effect.
- **Authored renderers** that set a status themselves aren't affected. eve's default renderer is
  the one that stays quiet.

### `guidance`

eve adds the string inside the message's block, after the metadata and before the content. For
an edit, it goes in the `<slack_message_edit>` block:

```text
<slack_message>
<sender>
type: user
id: U_BOB
</sender>
<bot>
id: U_BOT
mentioned: false
</bot>
<thread>…</thread>
<guidance>
You are part of this Slack thread, so you see replies people send each other. …
</guidance>
<content>
Alice, I can take the rollback.
</content>
</slack_message>
```

- **Per message.** Guidance describes one message, so it stays with that message through batching,
  compaction, and history. Earlier mentions in the same session don't carry it.
- **App-written.** The app writes guidance for the situation: a followed reply, a top-level
  message a decision model let through, a message from an external guest. eve exports no default
  text; the docs suggest some.
- **Trusted.** Guidance sits in eve's metadata area, outside `<content>`. An app that puts
  user-controlled text into it gives that text the authority of eve's own annotations, and the
  reference docs say so.
- **Not `context`.** The existing `context` field adds separate user-role messages before the
  turn's input. When several messages join one turn, core concatenates every delivery's `context`
  ahead of the merged messages, so the model can't tell which message a note belongs to. Guidance
  has to be inside the block, like the thread transcript and an edit's diff already are.

### Typed answers

Unchanged. A message can answer a pending approval or question when it comes from a principal
allowed to answer. That's an authorization rule, not a property of the message. A different
person's message waits for the held turn to end instead of steering it, and a response policy
refuses a wrong responder (both covered by e2e evals). Examples for overheard messages therefore
use `defaultSlackAuth(message, ctx)`, so each Slack user is their own principal. A hook that
returns `{ auth: null }` runs every message as the session's current identity, which makes
everyone in the thread the same principal.

### Following threads

The documented pattern uses existing helpers:

| Check                              | Why                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `message.author?.isBot === false`  | Another bot replying would loop.                                       |
| Not a mention, code channel, or DM | Those are addressed to the agent and get a plain `{ auth }`.           |
| `message.threadTs !== message.ts`  | Top-level messages start their own thread, so they need a mention.     |
| `ctx.isSubscribed()`               | The agent follows a thread only once a mention or the app admitted it. |

A message that mentions the bot arrives as `app_mention`. When eve knows the bot's user id, it
skips the `message.*` copy before `onMessage`, so a mention isn't delivered twice. Routing doesn't change:
unmentioned channel messages reach only an authored `onMessage`, and `onEvent` keeps its
documented priority over every built-in default.

eve's generated manifest already subscribes to `message.channels` and `message.groups` with
their history scopes, because message edits use them. Apps that configure Slack by hand, or
through Vercel Connect, need those subscriptions; without them, `onMessage` receives no replies.
The current docs disagree on whether Connect's defaults include them (`index.mdx` says to add
them; `reference.mdx` says they're included), so the implementation PR confirms and fixes
whichever page is wrong.

### Joining conversations with a decision model

A hook that returns `null` sends nothing, so no session starts. That makes a fast, cheap decision
model a filter in front of the agent:

```ts
// THREAD_GUIDANCE and JOIN_GUIDANCE are strings the app writes; `decide` is from `eve/ai`.
async onMessage(ctx, message) {
  if (message.author?.isBot !== false) return null;
  const auth = defaultSlackAuth(message, ctx);
  if (ctx.isBotMentioned() || ctx.slack.codeChannel || message.raw.channel_type === "im") {
    return { auth };
  }
  const followed = message.threadTs !== message.ts && (await ctx.isSubscribed());
  if (followed) return { auth, status: "deferred", guidance: THREAD_GUIDANCE };
  const result = await decide({
    state: { latestMessage: message.text },
    questions: {
      respond: {
        type: "choice",
        instructions: "Decide whether the agent could help with this message.",
        criteria: { ignore: "Not relevant to the agent", respond: "Something the agent can help with" },
      },
    },
  });
  return result.answers.respond.choice === "respond"
    ? { auth, status: "deferred", guidance: JOIN_GUIDANCE }
    : null;
}
```

| Stage                                      | Question                             | Tuned for                           |
| ------------------------------------------ | ------------------------------------ | ----------------------------------- |
| `decide` with a fast model, in `onMessage` | Could the agent plausibly help here? | Recall: let borderline messages in  |
| The agent's model, with `guidance`         | Should I actually say something?     | Precision: `no_reply` unless useful |

- **The decision model only gates new conversations.** Once it admits a message, that thread
  has a session, and later replies pass `isSubscribed()` without another `decide` call.
- **Joining mid-thread.** Running the same check on a reply in a thread without a session lets
  the agent join a conversation in progress. That message starts the session, so `threadContext`
  seeds the earlier replies as history.
- **Failure.** A hook that throws drops the message and eve logs the error. An app that would
  rather answer catches the error.
- **Privacy.** The decision model sees every unmentioned message the app receives, so channel
  content reaches it too.

### Edits

Today an authored `onAppMention`, `onDirectMessage`, or `onMessage` turns off the default edit
hook, so an app that follows threads silently loses edit steering.

The default edit hook instead runs the message hook a new message of the same kind would reach,
on the edited message:

| Edited message                    | Hook that decides                                       |
| --------------------------------- | ------------------------------------------------------- |
| In a DM                           | `onDirectMessage` → `onMessage` → built-in DM default   |
| Mentions the bot, before or after | `onAppMention` → `onMessage` → built-in mention default |
| In a code channel                 | `onMessage` → `onAppMention` → built-in default         |
| Other                             | `onMessage` → ignore                                    |

The app's own access checks apply to edits with no extra code. The edit keeps its own treatment:
the `<slack_message_edit>` block, no acknowledgement, and a quiet turn. `guidance` on the result
goes into the edit block. With the following pattern, an edit to a followed reply reaches the
session with the same guidance, and an edit to an unrelated message is dropped.

An authored `onMessageEdited` still replaces this, and `onEvent` still comes before it. Apps
without message hooks see no change: the built-in defaults answer the same edits that
`defaultOnMessageEdited` does today.

## Thread context

`threadContext` exists so the agent sees thread messages it never received. In a followed
thread, both of its possible behaviors fail:

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
history. This can ship separately; until it does, `threadContext` is unchanged.

## Alternatives considered

- **One semantic flag** (`ambient: true`, or `addressed: false`). It bundled status, guidance,
  and typed-answer handling, so it was hard to name and couldn't carry situation-specific text.
- **A `typedAnswers` prop.** Who can answer a pending request is an authorization rule core
  already enforces by principal, not a property of the message.
- **`threads: { follow: true }`.** It saves a few lines, but an authored `onMessage` replaces
  it, so apps with any custom routing write the check anyway: two ways to do one thing on a
  stable API.
- **A `ctx.isFollowUp()` helper.** After the hook handles bots, mentions, DMs, and code channels,
  it equals `isSubscribed()` plus a thread check. It can be added later if following grows real
  rules, such as ending after inactivity.
- **Following by default.** eve is at a release candidate, so the default is still cheap to
  change. But on upgrade, side conversations would start reaching model context, session history,
  and traces, every reply in a followed thread would cost a model call, and opting out would mean
  writing mention and DM routing by hand.
- **A generated snippet** in `eve add channel/slack`. The documented pattern is short enough for
  an author or coding agent to write when needed, and generated code would make following a
  default in all but name.
- **Guidance through `context`.** It loses the link to its message when messages batch into one
  turn.
- **A routing path behind `threads.follow` (#5797).** About twice the production code, with the
  treatment reachable only through the boolean. It also put the built-in routes ahead of
  `onEvent`, which let unmentioned replies skip an app's `onEvent` gate.
- **Recording a message without a turn.** The agent would see side conversations later, without
  a model call per message. Core has no way to add a message to a session without starting a
  turn, so this needs its own proposal.

## Boundaries

- Everything lives in `eve/channels/slack`. No harness, execution, or channel contract changes.
- No new top-level `slackChannel` option and no generated code.
- Unmentioned channel messages are still ignored without an authored `onMessage`.
- Code channel routing, `onEvent` priority, and typed-answer authorization stay as documented.
- `no_reply` stays opt-in, with no build warning.

## Open questions

1. **Renderers and `status`.** Should authored renderers see a message's `status`, so a custom
   `received` can show its own signal, such as a reaction, instead of nothing?
2. **More `status` values.** Is `"off"`, never showing status for the turn, needed? It can be
   added later without breaking anything.
3. **Thread context boundary.** Read the checkpoint in the `deliver` hook, which runs with the
   session's state and can fetch the gap there, or add a session state read to inbound handling?
4. **Group DMs.** The following pattern applies to group DM threads, which need `message.mpim`
   and `mpim:history`. Apps configured outside eve's manifest may lack them.
5. **Engagement decay.** A long-lived thread keeps the agent in forever. If a session that ends
   from an idle timeout releases its thread, `isSubscribed()` already stops following then.

## Validation

- Unit:
  - `status: "deferred"`: no `received`, the quiet turn across `no_reply`, a real tool, an edit,
    a mixed turn, and a mention steered into a quiet turn; `"immediate"` unchanged;
  - `guidance`: placement in `<slack_message>` and `<slack_message_edit>`, and per message when
    messages batch into one turn;
  - the default edit hook running each row of the edit table, including an authored `onMessage`
    that drops an edit;
  - the documented following pattern end to end through `onMessage`.
- Thread context: the checkpoint moving only forward, ignoring edits, and each `since` row.
- E2E: a fixture eval where Alice mentions the agent, Bob and Alice talk in the thread and the
  agent calls `no_reply`, then Alice asks a follow-up without a mention and the agent answers.
