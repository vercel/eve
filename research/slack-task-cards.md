---
issue: https://github.com/vercel/eve/pull/4028
status: implemented
last_updated: "2026-09-30"
---

# Slack task cards and composable rendering

This plan, implemented in [#4028](https://github.com/vercel/eve/pull/4028), redesigns what a person sees when an eve agent works in a Slack thread, built around
[tasks](../docs/tools/tasks.md) and Slack's task card and plan blocks. It also separates inbound
handling (`onAppMention`, `onDirectMessage`, `onMessage`, `onEvent`) from rendering, and replaces
both the `events` map and the experimental activity renderers with one chain of renderers that
wraps eve's defaults. Paths are relative to `packages/eve/src/`.

## Summary

1. **Each task a root turn starts gets a live row in a task card.** When a turn starts its first
   task, eve posts one message in the thread and keeps it updated. One task renders as a
   `task_card` block, and two or more render as a `plan` block. Each row shows the task's title,
   its status, and a one-line result when it settles. Tasks that an agent task starts on its own
   add no rows.
2. **Short work stays in the status line.** Thinking, ordinary tool calls, and waits use Slack's
   thread status. They never post messages, so the thread holds only the conversation and the
   task card.
3. **The card is a posted message that eve updates, not a stream.** Tasks can run for minutes or
   days. Slack stops streams after a few minutes, and `chat.update` fails while a stream is open.
   So eve posts the card with `chat.postMessage` and changes it with `chat.update`.
4. **eve's default message hooks don't render.** A message hook decides whether to start a turn
   and with what auth, and eve's rendering no longer depends on which hook ran. A custom hook can
   still post through its context, but it no longer has to recreate eve's rendering. The `Thinking...` acknowledgement moves from `defaultOnAppMention` into eve's default
   renderer, so a custom `onAppMention` keeps it. It is optimistic: it appears the moment a
   mention or DM arrives, while the hook is still deciding, and eve clears it if the hook drops the
   message.
5. **Rendering is a chain.** `slackChannel({ renderers: [a, b] })` wraps eve's default renderer.
   Each event handler receives `next`, so it can run before or after the default, change its
   input, or skip it. `taskCard(view, next)` is a pure function that returns blocks; eve owns
   posting and updating. The view carries every tool call of the turn with its
   input, so an app can put its own tools on the card, such as a checklist, without eve knowing
   about them.
6. **The card renders from the root session's own events.** The root session's Slack channel
   tracks its turns' calls and writes the card itself. The experimental activity renderers and the
   activity collector behind them are removed: no extra workflow runs per session, and cards
   follow the session across deploys. A collector may return later, designed from scratch, for
   what only other sessions can see, such as an agent task's own progress.

## Before this change

Three separate mechanisms write to a Slack thread, and nothing in the default setup shows tasks.

| Mechanism                                                       | Runs                                                | Sees                                              | Default |
| --------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- | ------- |
| Message hooks (`defaultOnAppMention`, `defaultOnDirectMessage`) | Inbound webhook, before the runtime starts          | The Slack message                                 | Yes     |
| `events` handlers (`defaults.ts`)                               | Inline, while the root session publishes each event | The root session's events, but no `task.*` events | Yes     |
| Activity collector plus renderers (`execution/activity-*.ts`)   | Separate durable workflow for each root session     | Root, child, and remote agent activity, debounced | No      |

**The default experience.** eve posts `Thinking...` from the default mention and DM hooks. Then
`turn.started`, `reasoning.appended`, and `actions.requested` update the thread status through
`assistant.threads.setStatus`, and `message.completed` posts replies. `ChannelEvents`
(`public/definitions/channel.ts`) has no `task.started`, `task.settled`, or `turn.waiting`. A turn
held on tasks therefore shows its last status until Slack clears it after two minutes, and then
nothing until the next reply.

**The experimental renderers** (`public/channels/slack/activity.ts`, `activity-plan.ts`) are
exported but not documented. The first renderer in `activity.renderers` starts the collector.
Child and remote agent sessions send it activity batches over HTTP, and it re-renders at most every
350 ms.

- `experimental_slackActivityStatus()` drives the status line from the collector. When it is
  present, `slackChannel` silently swaps out the default `turn.started`, `reasoning.appended`,
  `actions.requested`, and `message.completed` handlers (`slackChannel.ts`).
- `experimental_slackActivityTree()` posts a Unicode tree, one message per root turn, capped at
  20 lines. To recover its message it scans `conversations.replies`, which needs history scopes
  the default manifest doesn't request.
- `experimental_slackActivityPlan()` opens a `chat.startStream` in plan mode for each root turn
  and keeps it open until all of the turn's work settles. It appends child steps to the parent
  row's `details`, then stops the stream and replaces it with a `plan` block through
  `chat.update`. Its plan title is always `Agent activity`, the root row reads `Agent turn`, and
  cancelled work renders as `error`.
- `experimental_slackActivityRenderer({ id, render, dispose })` gives authors the raw
  `ActivitySnapshotV1`, including `pendingSettlements` and `seenEventIds`. Authors must make every
  Slack call themselves and track their own message state.

**Coupling problems.**

1. **Routing decides rendering.** The default mention and DM hooks both derive auth and post
   `Thinking...`. A custom `onAppMention` for gating or auth drops the acknowledgement. The
   doc comment even says "replacing this replaces both". An authored `onMessage` catches mentions
   and DMs too, so it drops the acknowledgement for them as well.
2. **Overriding means replacing.** `events["message.completed"]` replaces reply posting. To add a
   footer or feedback buttons, an author has to re-implement long-reply snippet uploads.
   `input.requested`, with its `defaultDeliver`, is the only handler that composes.
3. **Options interact in hidden ways.** Adding a status renderer changes which event handlers
   run.
4. **Custom activity rendering is too low-level.** Authors see eve's internal reduction state.
   They must handle `ts`, rate limits, streams, and recovery, and can't build on eve's default.

## What Slack offers

A [parallel research pass](#sources) checked Slack's reference pages and SDK source on 2026-09-30.
These are the facts that shape this design.

- **`task_card` block:** `task_id`, `title`, `status`, optional `details` and `output` (one
  `rich_text` block each), and `sources` (URL elements). `status` is `pending`, `in_progress`,
  `complete`, or `error`. There is no `cancelled` status and no nesting.
- **`plan` block:** a `title` and up to 50 tasks, each a task card without `type`.
- **Streams** (`chat.startStream`, `appendStream`, `stopStream`) send `task_update` and
  `plan_update` chunks, whose text is limited to 256 characters. Streams are thread replies. In
  channels they need `recipient_user_id` and `recipient_team_id`. `chat.update` on a message that
  is still streaming fails with `streaming_state_conflict`. Slack documents no stream lifetime.
  Developers report streams being stopped server-side after about 30 seconds idle, or about 5
  minutes in total. After that, the message shows a permanent error pill.
- **Posted blocks:** the Node SDK types accept `task_card` and `plan` in `chat.postMessage`, and
  the removed plan renderer already sent a `plan` block through `chat.update`. No Slack page
  explicitly confirms that these blocks render outside a stream; confirming it in a workspace is
  part of this change's manual validation.
- **Update rate:** `chat.update` is Tier 3 (50+ per minute for each workspace), and Slack's agent
  design guide says to update at most once every 3 seconds.
- **Status:** `assistant.threads.setStatus` takes up to 10 `loading_messages`. The status clears
  when the app replies, or after 2 minutes. Its replacement, `agents.sessions.setStatus`, keeps
  `processing` for an hour and enables Slack's native stop button.
- **Design guidance:** plans suit multi-step work where the agent makes decisions. Each step
  should be one short phrase, and plans should stay visually secondary to the final answer.
  Failures should keep partial progress visible.

## The default experience

Alice asks in a channel thread. The agent answers one question directly, then delegates two
long pieces of work as tasks.

```text
Alice   @eve why did checkout latency spike yesterday?
          [status] eve is thinking...
          [status] eve is searching logs "checkout p99"...
eve     ┌ Working on 2 tasks ───────────────────────────────────────────────┐
        │ ◐ Deploy history for storefront                                   │
        │ ◐ researcher: Find the incidents behind the checkout spike        │
        │     Reading INC-2291 postmortem                                   │
        └────────────────────────────────────────────────────────────────┘
eve     Checking recent deploys and incident notes in parallel; I'll report back.
          [status] eve is waiting on deploy and 1 more task...
```

Later, the same card message has been updated in place, and the answer follows below it:

```text
eve     ┌ Finished 2 tasks ─────────────────────────────────────────────────┐
        │ ✓ Deploy history for storefront                                   │
        │     3 deploys; 14:02 changed the cache TTL                        │
        │ ✓ researcher: Find the incidents behind the checkout spike        │
        │     INC-2291: cache stampede after the 14:02 deploy               │
        └───────────────────────────────────────────────────────────────┘
eve     The spike started at 14:04, two minutes after deploy dpl_8f2...
```

### Status line

The status line shows work that finishes within a step. The default renderer owns it:

| Moment                                 | Status                                                 |
| -------------------------------------- | ------------------------------------------------------ |
| A mention or DM arrives (webhook side) | `Thinking...`, right away, while the message hook runs |
| The message hook drops the message     | Cleared                                                |
| `turn.started`                         | `Working...`                                           |
| `reasoning.appended`                   | First line of the reasoning, throttled as before       |
| `actions.requested`                    | The model's narration, or the action label, as before  |
| `turn.waiting`, tasks working          | `Waiting on researcher and 2 more tasks...`            |
| A reply posts                          | Cleared by Slack                                       |

The status names the waiting turn's working tasks by tool or agent name. Slack clears a status
after two minutes without a message, and nothing runs in the root session while it waits, so the
status is short-lived by design: the task card is the long-lived signal during a long wait.

### Task card

- **One card for each root turn that starts a task.** The root session posts it on the turn's
  first `task.started`, then updates it in place until the turn and its tasks finish. A resumable
  task continued in a later turn shows up in that turn's card as a new call.
- **Rows are the root turn's own task calls.** What an agent task or workflow run does on the
  task's behalf, including tasks it starts, happens in other sessions and adds no rows.
- **Block choice.** One task renders as a standalone `task_card`, and a second task turns the
  message into a `plan`. More than 50 calls in one turn collapse the oldest settled ones into a
  single `N tasks finished earlier` row.
- **Plan title**, first match wins: `Waiting for approval`, `Waiting for a response`, or
  `Waiting for sign-in` while any task is blocked on a person; `Working on N tasks`, or
  `D of N tasks done` once some have settled; `Finished N tasks`, or
  `Finished N tasks: F failed, S stopped`, naming only the counts that aren't zero.
- **Rows:**

| Field    | Tool task                                                                                    | Agent task                                       |
| -------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `title`  | `label.start(input)`, else the tool name                                                     | `name: first line of message`                    |
| `status` | `in_progress` while working or blocked; `complete`; `error` for failed or cancelled          | Same                                             |
| `output` | First line of a string result; `Failed`, with the error's first line when private; `Stopped` | First line of the agent's reply; same for errors |

Titles are capped at 80 characters and `output` at 200.

- **Blocked rows.** A request or sign-in a task's run relays through the root carries the task's
  `taskId`, so its row shows `Waiting for approval`, `Waiting for a response`, or `Waiting for
sign-in` in `details`. The row goes back to working on the request's `input.resolved`, the
  sign-in's `authorization.completed`, or the task's `task.settled`. The request itself posts
  wherever `approvalChannel` sends it.
- **Requests stay where `approvalChannel` sends them.** A blocked row names the request's prompt
  only in a DM or private channel. Elsewhere `blockedOn` carries only its kind, since a request
  sent to one person by DM would otherwise show in the shared thread.

- **Failure text stays private.** In a DM or private channel, a failed row shows `Failed: ` and
  the first line of `task.settled.error.message`. Error text can carry internal hostnames or
  identifiers, so other channels show `Failed` alone. The view leaves a failed task's `summary`
  out there too, so a custom `taskCard` can't leak it by accident.
- **Stopped is not success.** Slack has no cancelled status. A cancelled row uses `error` with the
  output `Stopped`, so it never shows a success check. The plan title counts stopped tasks
  separately from failed ones.
- **Writes are per card, and only on change.** eve fingerprints the card and writes it only when
  it changed. A failed post or update is tried once more after a second; if that fails too, the
  card keeps its last fingerprint, so the turn's next change writes it again. An update that fails
  with `message_not_found`, because someone deleted the card, posts it again. Posts set
  `unfurl_links` and `unfurl_media` to `false`.
- **Where it doesn't appear:** schedule turns, which post only their final reply, and sessions
  without a Slack thread.

## Authoring API

### Inbound handlers route; renderers render

Message hooks keep their signatures and return values, and eve's default hooks post nothing. `defaultOnMessage`
only derives auth. Acknowledging a message is rendering, so it belongs to the renderer chain's
`received` handler:

- **Mentions and DMs** are addressed to the agent. eve runs `received` on the webhook side as soon
  as the message passes signature and self-message checks, at the same time as the message hook.
  The default sets `Thinking...`, before the hook's auth work and before the runtime cold-starts.
- **Other channel messages** reach `onMessage`, which drops most of them. For those, `received`
  runs only after the hook dispatches, so unrelated messages never flash a status.
- **A dropped message is cleared.** If the hook returns `null` or throws, eve clears the thread
  status once `received` finishes. Anything else a custom `received` posted is its own to clean up.

### Renderers

```ts
import { defineSlackRenderer, slackChannel } from "eve/channels/slack";

const feedback = defineSlackRenderer({
  events: {
    async "message.completed"(event, channel, _ctx, next) {
      await next(); // eve posts the reply, or uploads a long one as a snippet
      if (event.finishReason !== "tool-calls") await channel.thread.post(feedbackButtons());
    },
  },
  taskCard(view, next) {
    const card = next(view); // eve's default blocks and fallback text
    if (card === null || view.state !== "finished") return card;
    return { ...card, blocks: [...card.blocks, costContext(view)] };
  },
});

export default slackChannel({
  onAppMention(ctx, message) {
    return isAllowed(message) ? { auth: slackAuth(message) } : null; // routing and auth only
  },
  renderers: [feedback],
});
```

- **`renderers`** is an ordered list. The first renderer is outermost, and eve's default renderer
  is always innermost. Omitting `renderers` renders with the default alone, so a channel with no
  renderers looks exactly like eve's default. `events` is removed.
- **A renderer** has three optional parts: `received(message, channel, next)`, `events`, and
  `taskCard(view, next)`. Every message eve writes to Slack goes through one of them.
- **Event handlers** receive `(data, channel, ctx, next)`; `session.failed` receives
  `(data, channel, next)`. `next()` runs the rest of the chain with the same data and
  `next(data)` with changed data. The rest of the chain runs at most once. Not calling `next`
  skips it, so an old `events` override moves into `renderers: [{ events }]` unchanged.
- **The private sign-in rule holds.** A renderer's `authorization.required` handler receives only
  `postEphemeral`, `postDirectMessage`, and `state`. Its `next` reaches eve's default, which keeps
  the full context and posts the public link-free status.
- **`taskCard`** is synchronous and pure, and runs for every root turn that calls a tool. It
  returns `{ blocks, text }`, or `null` for no card; eve's default returns `null` for a turn that
  started no tasks.
  eve compares the result with what it last wrote and posts or updates the message. A `taskCard`
  that throws leaves that turn's card as it was.
- **New channel events.** `ChannelEvents` gains `task.started`, `task.settled`, `turn.waiting`,
  and `input.resolved`, so every channel can observe tasks inline and learn when each request
  ends, however it ended. `input.resolved` already existed for clients and hooks; channels
  couldn't handle it.

### The task card view

`taskCard` receives the channel-neutral view eve's default renders from
(`channel/task-card.ts`):

```ts
interface TaskCardView {
  readonly turnId: string;
  readonly state: "working" | "blocked" | "finished";
  readonly tasks: readonly TaskCardTask[]; // in call order
  readonly actions: readonly TaskCardAction[]; // the turn's other tool calls, in call order
}

type TaskCardStatus = "working" | "completed" | "failed" | "cancelled";

interface TaskCardTask {
  readonly id: string; // the call id; a resumable task called twice has two rows
  readonly taskId: string;
  readonly kind: "agent" | "tool";
  readonly name: string;
  readonly title: string;
  readonly status: TaskCardStatus | "blocked";
  readonly blockedOn?: {
    readonly kind: "approval" | "input" | "authorization";
    readonly label?: string; // only in a private conversation
  };
  readonly summary?: string; // a failure's only in a private conversation
  readonly startedAt: string;
  readonly settledAt?: string;
}

interface TaskCardAction {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly status: TaskCardStatus;
  readonly input?: Readonly<Record<string, unknown>>; // left out past 4,096 characters of JSON
  readonly startedAt: string;
  readonly settledAt?: string;
}
```

A card is `blocked` while any task waits on a person, `working` while its turn or any other task
works, then `finished`.

## Architecture

Everything renders in the root session, from the events it already publishes. The same renderer
chain defines every message.

```text
Slack webhook ─┬─► renderers.received ─► status: Thinking... (right away)
               └─► message hook (route, auth) ─► dispatch, or drop and clear status

root session ─ own events ─► renderers.events ─► replies, questions, sign-ins, errors, status
              │
              └─► task card tracking (actions.requested, action.result, task.started,
                   task.settled, relayed requests and their resolutions, turn end)
                   ─► renderers.taskCard(view) ─► post, then update
```

**Invariants:**

1. **No extra work outside the session.** The card is tracked in the Slack channel's state, which
   the root session persists with every step. No workflow, route, or sink exists for it, so a
   session that never starts a task pays one `taskCard` call per tool-call event and nothing else.
2. **One writer per card.** Only the root session writes, and its steps run one after another. The
   card's `ts` and a fingerprint of what eve last wrote live next to the turn's calls, so there is
   no `conversations.replies` scan and no history scope.
3. **Tracking can't be skipped.** Tracking and writing wrap the renderer chain's handlers for
   those events, so a renderer that replaces eve's default for one of them still gets a card.
4. **Cards follow the session.** Rendering is session code, so after a deploy a handed-off session
   renders with the new deployment's code, and there is nothing pinned to the old one.
5. **Rendering never fails a turn.** A failed write is retried once, then logged; the turn's next
   change writes the card again.
6. **State stays bounded.** eve forgets a turn once its card is finished, tracks at most 20
   unfinished turns and 100 calls per turn, and keeps a call's input only up to 4,096 characters
   of JSON.

## Alternatives considered

- **A streamed plan for each turn** (the removed plan renderer). This is Slack's native pattern for
  short turns, but tasks outlive streams, and a stopped stream leaves a permanent error pill.
- **Render the card in the activity collector,** a separate durable workflow per root session that
  child and remote sessions report to over HTTP. It is the only way to show an agent task's own
  steps and to refresh the status during a long wait. It also runs a second
  workflow per session, stays pinned to the deployment that started it for up to the session
  timeout (30 days by default), and has to accept activity from newer code after a handoff. The
  first versions of this change used it; rendering from the root's own events keeps what people
  asked for with far less. A collector may return, designed from scratch, for what only other
  sessions can see.
- **Let subagents call the channel's handlers.** The card's state belongs to the root session, and
  `chat.update` rewrites the whole message, so parallel agents writing their own rows would
  overwrite each other with stale rows. Remote agents can't run the app's handlers at all.
- **Keep custom activity renderers public.** That exposes reduction internals, makes every author
  handle `ts`, rate limits, and recovery, and offers no way to build on eve's card.
- **`preventDefault` instead of `next`.** Authors could neither change the default's input nor
  choose to run before or after it. `next` matches the old `defaultDeliver`.

## Removed and changed

Everything below is breaking, which is allowed before 1.0.

- **Removed:** `slackChannel({ activity })`, `experimental_slackActivityStatus`,
  `experimental_slackActivityTree`, `experimental_slackActivityPlan`,
  `experimental_slackActivityRenderer`, the `ExperimentalSlackActivity*` types,
  `SlackChannelEvents`, `SlackInputRequestedHandler`, `SlackInputRequestedDefaultDeliver`,
  `SlackInputRequestedEvent`, and `SlackAuthorizationRequiredHandler`.
- **`events` → `renderers`:** `events: { … }` becomes `renderers: [{ events: { … } }]`, with the
  same behavior. `input.requested`'s `defaultDeliver` becomes `next`.
- **Message hooks:** the default mention and DM hooks no longer post `Thinking...`. The default
  renderer's `received` does, right away for mentions and DMs, whichever hook handles them.
- **Channel core:** `ChannelEvents` gains `task.started`, `task.settled`, `turn.waiting`, and
  `input.resolved`.
- **Removed: the activity collector** and everything that fed it: the `/eve/v1/activity` route,
  the activity protocol and reducer, the per-step activity posting, and the `activityObserver`
  field on delegated and remote-agent sessions. A remote-agent request from an older eve that still
  sends `activityObserver` is accepted, and the field is ignored.
- **New default output:** task cards, and the `Waiting on ...` status.

## Follow-ups

- **Settlement labels.** `label.complete(input, output)` runs on a task's receipt today, not its
  result. Running it at settlement needs the tool definition where the call settles; until then,
  summaries come from the result text.
- **What only other sessions see.** An agent task's own steps and a status that stays up during a
  long wait need something besides the root session. Revisit a collector, or another mechanism,
  designed from scratch for these.
- **Answered cards from `input.resolved`.** Slack marks a question card answered when someone
  clicks it. A plain-text answer or a withdrawn question leaves its buttons; the default handler
  could mark the card from `input.resolved` instead.
- **Tool task progress.** A task run's `action.partial` carries no `label.delta`, so a tool task
  row shows no progress.
- **Agent sessions.** Move status to `agents.sessions.setStatus`, which keeps `processing` for an
  hour, and map Slack's native stop button (`agent_session_stopped`) to `session.cancel()`.
- **Streamed replies.** Stream reply text with `chat.startStream` for turns that start no tasks.
- **Stop controls on the card.** A `context_actions` stop button that cancels the turn.
- **Templates.** The personal agent template sets `Thinking…` in its message hooks; remove it once
  the template moves to a release with `received`.

## Decisions

When a choice was open, clarity for the person reading the thread decided it.

1. **Failures show their reason where it's safe.** A bare `Failed` leaves people guessing, but
   error text can carry internals. Rows show the error's first line in DMs and private channels,
   and `Failed` alone elsewhere.
2. **Stopped rows never look successful.** A cancelled task uses `error` with `Stopped`, and the
   plan title counts it apart from failures.
3. **The card has one writer.** The root session posts the card and owns every update, so there is
   never a second message or a stale overwrite.
4. **Acknowledging is rendering, and it is immediate.** `Thinking...` belongs to `received` in the
   renderer chain, not to message hooks. It appears right away for mentions and DMs and is cleared
   if the message is dropped.
5. **Apps own their tools' presentation.** eve doesn't ship a checklist tool. The view carries the
   turn's own tool calls with their input, so an app's `plan` tool, or any other, renders through
   `taskCard` without a change to eve.

## Sources

- Slack: [task card block](https://docs.slack.dev/reference/block-kit/blocks/task-card-block),
  [plan block](https://docs.slack.dev/reference/block-kit/blocks/plan-block),
  [chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream),
  [chat.stopStream](https://docs.slack.dev/reference/methods/chat.stopStream),
  [chat.update](https://docs.slack.dev/reference/methods/chat.update),
  [assistant.threads.setStatus](https://docs.slack.dev/reference/methods/assistant.threads.setStatus),
  [agents.sessions.setStatus](https://docs.slack.dev/reference/methods/agents.sessions.setStatus),
  [agent design](https://docs.slack.dev/concepts/agent-design),
  [2026-02-11 changelog](https://docs.slack.dev/changelog/2026/02/11/task-cards-plan-blocks),
  [python-slack-sdk#1859](https://github.com/slackapi/python-slack-sdk/issues/1859) (stream
  lifetime reports).
- eve: `research/eve-tasks.md`, `docs/tools/tasks.md`, `docs/channels/slack.mdx`,
  `channel/task-card.ts`, `public/channels/slack/{slackChannel,defaults,renderers,task-card}.ts`,
  `cli/dev/tui/task-activity.ts`.
