---
issue: TBD
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

1. **Every task gets a live row in a task card.** When a turn starts its first task, eve posts one
   message in the thread and keeps it updated. One task renders as a `task_card` block, and two or
   more render as a `plan` block. Each row shows the task's title, what it is doing now, and a
   one-line result when it settles.
2. **Short work stays in the status line.** Thinking, ordinary tool calls, and waits use Slack's
   thread status. They never post messages, so the thread holds only the conversation and the
   task card.
3. **The card is a posted message that eve updates, not a stream.** Tasks can run for minutes or
   days. Slack stops streams after a few minutes, and `chat.update` fails while a stream is open.
   So eve posts the card with `chat.postMessage` and changes it with coalesced `chat.update`
   calls.
4. **Inbound handlers never render.** A message hook decides whether to start a turn and with
   what auth. The `Thinking…` acknowledgement moves from `defaultOnAppMention` into eve's default
   renderer, so a custom `onAppMention` keeps it. It is optimistic: it appears the moment a
   mention or DM arrives, while the hook is still deciding, and eve clears it if the hook drops the
   message.
5. **Rendering is a chain.** `slackChannel({ renderers: [a, b] })` wraps eve's default renderer.
   Each event handler receives `next`, so it can run before or after the default, change its
   input, or skip it. `taskCard(view, next)` is a pure function that returns blocks; eve owns
   posting, updating, and rate limits.
6. **The experimental activity renderers are removed.** eve keeps the activity collector as the
   internal engine behind the task card. `activity.renderers`, `experimental_slackActivity*`, and
   the raw snapshot contract go away.

## Before this change

Three separate mechanisms write to a Slack thread, and nothing in the default setup shows tasks.

| Mechanism                                                       | Runs                                                | Sees                                              | Default |
| --------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- | ------- |
| Message hooks (`defaultOnAppMention`, `defaultOnDirectMessage`) | Inbound webhook, before the runtime starts          | The Slack message                                 | Yes     |
| `events` handlers (`defaults.ts`)                               | Inline, while the root session publishes each event | The root session's events, but no `task.*` events | Yes     |
| Activity collector plus renderers (`execution/activity-*.ts`)   | Separate durable workflow for each root session     | Root, child, and remote agent activity, debounced | No      |

**The default experience.** eve posts `Thinking…` from the default mention and DM hooks. Then
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
   `Thinking…`. A custom `onAppMention` for gating or auth drops the acknowledgement. The
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

The status lists tasks by tool or agent name, from `task.started` and `task.settled`. When a task's
question posts, the status still names the task: the question card is the call to action, and the
task row says what it is waiting for.

### Task card

- **One card for each root turn that starts a task.** The collector posts it after the burst of
  `task.started` events that begins the work, then updates it in place until the turn ends. A
  resumable task continued in a later turn shows up in that turn's card as a new call.
- **Block choice.** One task renders as a standalone `task_card`, and a second task turns the
  message into a `plan`. More than 50 calls in one turn collapse the oldest settled ones into a
  single `N tasks finished earlier` row.
- **Plan title**, first match wins: `Waiting for approval`, `Waiting for a response`, or
  `Waiting for sign-in` while any task is blocked on a person; `Working on N tasks`, or
  `D of N tasks done` once some have settled; `Finished N tasks`, or
  `Finished N tasks: F failed, S stopped`, naming only the counts that aren't zero.
- **Rows:**

| Field     | Tool task                                                                           | Agent task                                              |
| --------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `title`   | `label.start(input)`, else the tool name                                            | `name: first line of message`                           |
| `status`  | `in_progress` while working or blocked; `complete`; `error` for failed or cancelled | Same                                                    |
| `details` | What a workflow run's `ctx.agent` session is doing, when it opens one               | The agent's latest running action, or what it waits for |
| `output`  | First line of a string result; `Failed: ` plus the error's first line; `Stopped`    | First line of the agent's reply; same for errors        |

Titles are capped at 80 characters and `details` and `output` at 200, each kept to one line.

- **Failures say why.** A failed row shows `Failed: ` and the first line of
  `task.settled.error.message` in every channel, public ones included. This is the text the model
  already receives and often repeats in its reply. A failure with no message reads `Failed`.
- **Stopped is not success.** Slack has no cancelled status. A cancelled row uses `error` with the
  output `Stopped`, so it never shows a success check. The plan title counts stopped tasks
  separately from failed ones.
- **Where it doesn't appear:** schedule turns, which post only their final reply, and sessions
  without a Slack thread.

## Authoring API

### Inbound handlers route; renderers render

Message hooks keep their signatures and return values, and they post nothing. `defaultOnMessage`
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
  is always innermost. `events` is removed.
- **A renderer** has three optional parts: `received(message, channel, next)`, `events`, and
  `taskCard(view, next)`. Every message eve writes to Slack goes through one of them.
- **Event handlers** receive `(data, channel, ctx, next)`; `session.failed` receives
  `(data, channel, next)`. `next()` runs the rest of the chain with the same data and
  `next(data)` with changed data. The rest of the chain runs at most once. Not calling `next`
  skips it, so an old `events` override moves into `renderers: [{ events }]` unchanged.
- **The private sign-in rule holds.** A renderer's `authorization.required` handler receives only
  `postEphemeral`, `postDirectMessage`, and `state`. Its `next` reaches eve's default, which keeps
  the full context and posts the public link-free status.
- **`taskCard`** is synchronous and pure. It returns `{ blocks, text }`, or `null` for no card.
  eve compares the result with what it last wrote and posts or updates the message. A `taskCard`
  that throws leaves that turn's card as it was.
- **New channel events.** `ChannelEvents` gains `task.started`, `task.settled`, and
  `turn.waiting`, so every channel can observe tasks inline.

### The task card view

`taskCard` receives the channel-neutral view eve's default renders from
(`channel/task-card.ts`):

```ts
interface TaskCardView {
  readonly turnId: string;
  readonly state: "working" | "blocked" | "finished";
  readonly tasks: readonly TaskCardTask[]; // in start order
}

interface TaskCardTask {
  readonly id: string; // unique in the card; a resumable task called twice has two rows
  readonly taskId: string;
  readonly kind: "agent" | "tool";
  readonly name: string;
  readonly title: string;
  readonly status: "working" | "blocked" | "completed" | "failed" | "cancelled";
  readonly activity?: string;
  readonly blockedOn?: {
    readonly kind: "approval" | "input" | "authorization";
    readonly label?: string;
  };
  readonly summary?: string;
  readonly startedAt: string;
  readonly settledAt?: string;
}
```

## Architecture

Rendering splits into two lanes by what each message needs. Both lanes are defined by the same
renderer chain.

```text
Slack webhook ─┬─► renderers.received ─► status: Thinking... (right away)
               └─► message hook (route, auth) ─► dispatch, or drop and clear status

root session ─ own events, inline ─► renderers.events
   │            replies, questions, sign-ins, errors, status line
   │
   │ first task call: start the collector, seed it, then task lifecycle
   ▼
task card presenter (collector workflow)  ─► renderers.taskCard(view) ─► post, then update
   ▲ activity
child and remote agent sessions
```

- **Conversation lane (inline).** Replies, question cards, sign-in notices, errors, and the status
  line stay in the root session's event handlers. Their order matters, and interactions such as
  approval updates depend on the channel state these handlers write.
- **Card lane (collector).** The card is a live view: safe to coalesce, and it has to include child
  agents' progress, which never reaches the root session's stream. The activity collector already
  combines root, child, and remote activity off the turn's critical path, so it is the single
  writer of the card, from its first post to its last update.

**Invariants:**

1. **Sessions without tasks pay nothing new.** The collector starts in the dispatch step
   (`execution/task-activity-observer.ts`) that starts a root session's first task, before the
   calls capture their agent context, so child sessions inherit the sink. Only root sessions of a
   channel with an activity presenter start one, and never a schedule's session. Before this
   change, it started at session creation when renderers were configured, which also required
   cancelling it when a session lost its continuation claim; that path is gone.
2. **The collector sees the whole turn.** The model step that made the calls ran before the
   collector existed, so the dispatch step seeds it with the turn's work and its task calls,
   labeled with the same projection the model step uses (`projectActionStarted`).
3. **A step waits for its activity.** Every publishing step awaits the activity it submitted before
   it returns (`SessionEventSink.flushActivity`), so a host that freezes after the step can't drop
   a task's settlement. Child activity only fills a row's details; losing it can't strand a status.
4. **One card per root turn, one writer.** The collector keeps each card's `ts` in its durable
   state, so there is no `conversations.replies` scan and no history scope.
5. **Updates are coalesced and rate-aware.** A change renders after a 350 ms debounce, which
   gathers a burst such as parallel task starts, and at most once every 3 seconds, always from the
   latest snapshot. The final state is always rendered.
6. **Rendering never affects a turn.** A failed render is retried once, then logged and skipped.

`ChannelActivityPresenter` (`channel/activity-presenter.ts`) is the internal seam between the
collector and a channel: one presenter per channel, not public.

## Alternatives considered

- **A streamed plan for each turn** (the removed plan renderer). This is Slack's native pattern for
  short turns, but tasks outlive streams, and a stopped stream leaves a permanent error pill.
- **Render tasks only from inline channel events.** Simpler, but it can't show what a child agent
  is doing, and it would put `chat.update` calls on the turn's critical path with no coalescing.
- **Post the card's first version inline.** It would pin the card's position exactly, but the card
  would then have two writers and the root would have to hand its `ts` to the collector. With the
  collector posting after a 350 ms debounce, the card lands before the text the model writes in its
  next step in practice.
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
- **Channel core:** `ChannelEvents` gains `task.started`, `task.settled`, and `turn.waiting`.
- **Activity protocol:** `task.started` and `task.settled` activity events mark an action as a task
  and carry its summary. They are new event kinds, so an older collector ignores them. Agent calls
  now project as actions, so each agent task has a row.
- **New default output:** task cards, and the `Waiting on ...` status.

## Follow-ups

- **Settlement labels.** `label.complete(input, output)` runs on a task's receipt today, not its
  result. Running it at settlement needs the tool definition where the call settles; until then,
  summaries come from the result text.
- **Tool task progress and questions.** A task run's `action.partial` carries no `label.delta`, and
  a `task()` body's `ctx.ask` is relayed through the root, which activity doesn't observe, so a tool
  task row shows neither.
- **Agent sessions.** Move status to `agents.sessions.setStatus`, which keeps `processing` for an
  hour, and map Slack's native stop button (`agent_session_stopped`) to `session.cancel()`.
- **Streamed replies.** Stream reply text with `chat.startStream` for turns that start no tasks.
- **Stop controls on the card.** A `context_actions` stop button that cancels the turn.
- **Templates.** The personal agent template sets `Thinking…` in its message hooks; remove it once
  the template moves to a release with `received`.

## Decisions

When a choice was open, clarity for the person reading the thread decided it.

1. **Failures show their reason.** A bare `Failed` leaves people guessing, and the reply often
   repeats the reason anyway. Rows show the first line of the error in every channel.
2. **Stopped rows never look successful.** A cancelled task uses `error` with `Stopped`, and the
   plan title counts it apart from failures.
3. **The card has one writer.** The collector posts it right after the burst that starts the work
   and owns every update, so there is never a second message or a stale overwrite.
4. **Acknowledging is rendering, and it is immediate.** `Thinking...` belongs to `received` in the
   renderer chain, not to message hooks. It appears right away for mentions and DMs and is cleared
   if the message is dropped.

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
  `public/channels/slack/{slackChannel,defaults,activity,activity-plan}.ts`,
  `execution/{activity-collector,activity-events,session-activity-projection}.ts`,
  `cli/dev/tui/task-activity.ts`.
