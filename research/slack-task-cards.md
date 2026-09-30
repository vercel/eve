---
issue: TBD
status: draft
last_updated: "2026-09-30"
---

# Slack task cards and composable rendering

This plan redesigns what a person sees when an eve agent works in a Slack thread, built around
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
   posting, updating, rate limits, and recovery.
6. **The experimental activity renderers are removed.** eve keeps the activity collector as the
   internal engine behind the task card. `activity.renderers`, `experimental_slackActivity*`, and
   the raw snapshot contract go away.

## Today

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
- **Posted blocks:** the Node SDK types accept `task_card` and `plan` in `chat.postMessage`. The
  experimental plan renderer already sends a `plan` block through `chat.update`. No Slack page
  explicitly confirms that these blocks render outside a stream, so this is PR 1's spike.
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
          [status] eve is thinking…
          [status] eve is searching logs "checkout p99"…
eve     Checking recent deploys and incident notes in parallel; I'll report back.
eve     ┌ Working on 2 tasks ───────────────────────────────────────────────┐
        │ ◐ researcher: incidents behind the checkout spike                 │
        │     Reading INC-2291 postmortem                                   │
        │ ◐ Deploy history for storefront                                   │
        │     Listing deployments since Sep 28                              │
        └───────────────────────────────────────────────────────────────────┘
          [status] eve is waiting on researcher and 1 more task…
```

Later, the same card message has been updated in place, and the answer follows below it:

```text
eve     ┌ Finished 2 tasks ─────────────────────────────────────────────────┐
        │ ✓ researcher: incidents behind the checkout spike                 │
        │     INC-2291: cache stampede after the 14:02 deploy               │
        │ ✓ Deploy history for storefront                                   │
        │     3 deploys; 14:02 changed the cache TTL                        │
        └───────────────────────────────────────────────────────────────────┘
eve     The spike started at 14:04, two minutes after deploy dpl_8f2…
```

### Status line

The status line shows work that finishes within a step. The default renderer owns it:

| Moment                                        | Status                                               |
| --------------------------------------------- | ---------------------------------------------------- |
| A mention or DM arrives (webhook side)        | `Thinking…`, right away                              |
| The message hook drops the message            | Cleared                                              |
| `turn.started`                                | `Working…`                                           |
| `reasoning.appended`                          | First line of the reasoning, throttled as today      |
| `actions.requested`                           | The model's narration, or the action label, as today |
| `turn.waiting`, tasks working                 | `Waiting on researcher and 1 more task…`             |
| `turn.waiting`, a question or sign-in pending | Cleared: the question card is the call to action     |
| A reply posts                                 | Cleared by Slack                                     |

### Task card

- **One card for each root turn that starts a task.** It is posted on the turn's first
  `task.started`, so it sits in the thread exactly where the work began, before any text the
  model writes afterward. It is then updated in place until the turn ends. A resumable task
  continued in a later turn shows up in that turn's card as a new call.
- **Block choice.** One task renders as a standalone `task_card`, and a second task turns the
  message into a `plan`. More than 50 calls in one turn collapse the oldest settled ones into a
  single `N earlier tasks finished` row.
- **Plan title**, first match wins: `Waiting for approval` or `Waiting for a response` while any
  task is blocked on a person; `Working on N tasks`, or `D of N tasks done` once some have
  settled; `Finished N tasks`, or `Finished N tasks: F failed, S stopped`, naming only the
  counts that aren't zero.
- **Rows:**

| Field     | Tool task                                                                           | Agent task                                       |
| --------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| `title`   | `label.start(input)`, else the tool name                                            | `name: first line of message`                    |
| `status`  | `in_progress` while working or blocked; `complete`; `error` for failed or cancelled | Same                                             |
| `details` | Latest `label.delta` (progress yielded by `async *task`)                            | The agent's latest running action label          |
| `output`  | `label.complete(input, output)`; `Failed: ` plus the error's first line; `Stopped`  | First line of the agent's reply; same for errors |

A blocked row's `details` names the person and the request: `Waiting for @alice to approve
Deploy storefront`. The question card itself still posts in the thread, as it does today. Titles
are capped at 80 characters and `details` and `output` at 200, each kept to a single line.

- **Failures say why.** A failed row shows `Failed: ` and the first line of
  `task.settled.error.message` in every channel, public ones included. This is the text the model
  already receives and often repeats in its reply. Tool authors own it, and the Tasks docs will say
  that a thrown message is shown to people. A failure with no message reads `Failed`.
- **Stopped is not success.** Slack has no cancelled status. A cancelled row uses `error` with the
  output `Stopped`, so it never shows a success check. The plan title counts stopped tasks
  separately from failed ones.

- **Fallback text** for notifications and screen readers: the plan title, followed by the task
  titles.
- **Where it doesn't appear:** schedule turns, which post only their final reply, and sessions
  without a Slack thread.

The default card for the second state above:

```json
{
  "type": "plan",
  "title": "Finished 2 tasks",
  "tasks": [
    {
      "task_id": "researcher-7k2m9q",
      "title": "researcher: incidents behind the checkout spike",
      "status": "complete",
      "output": {
        "type": "rich_text",
        "elements": [
          {
            "type": "rich_text_section",
            "elements": [
              { "type": "text", "text": "INC-2291: cache stampede after the 14:02 deploy" }
            ]
          }
        ]
      }
    },
    {
      "task_id": "deploys-4hd8sa",
      "title": "Deploy history for storefront",
      "status": "complete",
      "output": {
        "type": "rich_text",
        "elements": [
          {
            "type": "rich_text_section",
            "elements": [{ "type": "text", "text": "3 deploys; 14:02 changed the cache TTL" }]
          }
        ]
      }
    }
  ]
}
```

## Authoring API

### Inbound handlers route; renderers render

Message hooks keep their signatures and return values, and they stop posting anything.
`defaultOnAppMention` and `defaultOnDirectMessage` only derive auth. Acknowledging a message is
rendering, so it belongs to the renderer chain's `received` handler:

- **Mentions and DMs** are addressed to the agent. eve runs `received` on the webhook side as soon
  as the message passes signature and self-message checks, at the same time as the message hook,
  not after it. The default renderer's `received` sets `Thinking…`, so the status appears before
  the hook's auth work and before the runtime cold-starts.
- **Other channel messages** reach `onMessage`, which drops most of them. For those, `received`
  runs only after the hook dispatches, so unrelated messages never flash a status.
- **A dropped message is cleared.** If the hook returns `null` or throws after `received` ran, eve
  clears the thread status it set. Anything else a custom `received` posted is that renderer's to
  clean up.

### Renderers

```ts
import { defineSlackRenderer, slackChannel } from "eve/channels/slack";

const feedback = defineSlackRenderer({
  events: {
    async "message.completed"(event, channel, ctx, next) {
      await next(event); // eve posts the reply, or uploads a long one as a snippet
      if (event.finishReason === "stop") await channel.thread.post(feedbackButtons());
    },
  },
});

const costFooter = defineSlackRenderer({
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
  renderers: [feedback, costFooter],
});
```

- **`renderers`** is an ordered list. The first renderer is outermost, and eve's default renderer
  is always innermost. There is one way to render. `events` is removed.
- **A renderer** has three optional parts: `received(message, channel, next)`, `events`, and
  `taskCard(view, next)`. Every message eve writes to Slack goes through one of them.
- **Event handlers** receive `(data, channel, ctx, next)`. `session.failed` receives
  `(data, channel, next)` because it has no session context.
  - `next()` runs the rest of the chain with the same data, and `next(data)` runs it with changed
    data, as `defaultDeliver` does today.
  - Not calling `next` skips everything inside it, including eve's default. An existing `events`
    override moves into `renderers: [{ events }]` with unchanged behavior, because those handlers
    never call `next`.
- **The private sign-in rule holds.** An author's `authorization.required` handler receives only
  `postEphemeral`, `postDirectMessage`, and `state`, as today. Its `next` reaches eve's default,
  which posts the public link-free status.
- **`taskCard`** is synchronous and pure. It returns `{ blocks, text }`, or `null` for no card.
  eve compares the result with what it last rendered and posts or updates the message. Renderers
  never see a message `ts`, a stream, or a rate limit. Slack block types are eve-owned, not
  re-exported from `@slack/types`.
- **New channel events.** `ChannelEvents` gains `task.started`, `task.settled`, and
  `turn.waiting`. Every channel can observe tasks, and Slack's status line needs them. Handlers
  for these run inline like the other channel events.

### The task card view

`taskCard` receives the same channel-neutral view that eve's default renders from:

```ts
interface TaskCardView {
  readonly turnId: string;
  readonly state: "working" | "blocked" | "finished";
  readonly tasks: readonly TaskCardTask[]; // in start order
}

interface TaskCardTask {
  readonly taskId: string;
  readonly callId: string;
  readonly kind: "agent" | "tool";
  readonly name: string; // tool or agent name
  readonly title: string;
  readonly status: "working" | "blocked" | "completed" | "failed" | "cancelled";
  readonly activity?: string; // what it is doing now, one line
  readonly blockedOn?: {
    readonly kind: "approval" | "input" | "authorization";
    readonly userId?: string;
    readonly label?: string;
  };
  readonly summary?: string; // one line, once settled
  readonly startedAt: string;
  readonly settledAt?: string;
}
```

Customizing text is still mainly a job for tool labels, which work in every channel. The
`taskCard` hook is for layout, such as adding a context row, links, `sources`, or a button.

## Architecture

Rendering splits into two lanes by what each message needs. Both lanes are defined by the same
renderer chain.

```text
Slack webhook ─┬─► renderers.received ─► status: Thinking… (right away)
               └─► message hook (route, auth) ─► dispatch, or drop and clear status

root session ─ own events, inline ─► renderers.events
   │            replies, questions, sign-ins, errors, status line,
   │            first post of the task card (renderers.taskCard)
   │
   │ task lifecycle and card ts, durable
   ▼
task card presenter (collector workflow, started on the first task)
   ▲ activity, best effort          ─► renderers.taskCard(view) ─► coalesced update
child and remote agent sessions
```

- **Conversation lane (inline).** Replies, question cards, sign-in notices, errors, the status
  line, and the card's first post stay in the root session's event handlers. Their order matters,
  and interactions such as approval updates depend on the channel state these handlers write.
  Posting the card here puts it in a predictable place: after the text before the tasks started,
  and before any text after.
- **Card lane (collector).** After the first post, the card is a live view. Its updates are safe
  to coalesce, and they have to include child agents' progress, which never reaches the root
  session's stream. The activity collector already combines root, child, and remote activity off
  the turn's critical path, so it becomes the task card presenter and owns every later update.

**Invariants:**

1. **Status comes only from the root session.** A card's rows and statuses come from the root's
   own `task.started`, `task.settled`, blocker, and turn events, which the root delivers to the
   collector durably from its step. Today that delivery is fire-and-forget HTTP
   (`void observeSessionActivity`). Child activity only fills `activity`. A lost child batch can
   leave stale detail text, but it can never leave a row stuck in progress.
2. **One card for each root turn, owned by eve.** The root posts the card on the turn's first
   `task.started` and hands its `ts` to the collector with the task lifecycle. From then on the
   `ts` lives in the collector's durable state, so there is no `conversations.replies` scan and no
   history scope. Only the collector updates the card.
3. **Updates are coalesced and rate-aware.** Structural changes (a task starts, settles, or
   blocks) render after the existing debounce. Changes to detail text alone render at most once
   every 3 seconds for each card, and eve honors `Retry-After`. The final state is always
   rendered: the collector flushes when the turn ends, as #3424 does today.
4. **Rendering never affects a turn.** A card failure is logged and retried once, as renderer
   failures are today. It never fails, delays, or cancels the turn.
5. **Sessions without tasks pay nothing new.** The collector starts on the root's first
   `task.started`, before any child session opens, so the sink can be passed to children. Today it
   starts at session creation, and only when renderers are configured.
6. **Labels carry into settlement.** `task.settled` gains `presentation` with the result of
   `label.complete(input, output)`. Today `label.complete` runs only on `action.result`, which for
   a task is the receipt.

`ChannelActivityRenderer` (`channel/activity-renderer.ts`) stays as the internal seam between the
collector and a channel. It becomes one presenter for each channel instead of a list, and it is not
public.

## Alternatives considered

- **A streamed plan for each turn** (the experimental plan renderer). This is Slack's native
  pattern for short turns, but tasks outlive streams, and a stopped stream leaves a permanent
  error pill. Streams stay a candidate for reply text (see [Follow-ups](#follow-ups)).
- **Render tasks only from inline channel events.** This is simpler, but it can't show what a
  child agent is doing. It would also put `chat.update` calls on the turn's critical path, with no
  coalescing.
- **Keep custom activity renderers public.** That exposes reduction internals, makes every author
  handle `ts`, rate limits, and recovery, and offers no way to build on eve's card.
- **`preventDefault` instead of `next`.** Defaults would run alongside author code automatically,
  but authors could neither change the default's input nor choose to run before or after it.
  `next` matches the existing `defaultDeliver`.

## Removed and changed

Everything below is breaking, which is allowed before 1.0. The changeset is `minor`.

- **Removed:** `slackChannel({ activity })`, `experimental_slackActivityStatus`,
  `experimental_slackActivityTree`, `experimental_slackActivityPlan`,
  `experimental_slackActivityRenderer`, and the `ExperimentalSlackActivity*` types.
- **`events` → `renderers`:** `events: { … }` becomes `renderers: [{ events: { … } }]`, with the
  same behavior. `input.requested`'s `defaultDeliver` becomes `next`.
- **Message hooks:** `defaultOnAppMention` and `defaultOnDirectMessage` no longer post
  `Thinking…`. The default renderer's `received` handler does, right away for mentions and DMs,
  whichever hook handles them.
- **Channel core:** `ChannelEvents` gains `task.started`, `task.settled`, and `turn.waiting`.
  `task.settled` gains `presentation`.
- **New default output:** task cards, and the `Waiting on …` status.

## Delivery

| #   | PR                       | Main after it lands                                                                        |
| --- | ------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Slack block spike        | Findings in this plan: `plan` and `task_card` through post and update, in channels and DMs |
| 2   | Renderer chain           | `renderers` with `next`; optimistic `Thinking…` in `received`; `events` removed            |
| 3   | Task events for channels | `task.*` and `turn.waiting` in `ChannelEvents`; `Waiting on …` status; settled labels      |
| 4   | Task card                | Collector as presenter; default card; `taskCard`; experimental renderers removed           |
| 5   | Docs                     | Slack page: what people see, the task card, renderers; link from Tasks                     |

- **PR 1** posts both block types through `chat.postMessage` and `chat.update` in a test
  workspace. It covers channel threads, DMs, a `task_card` becoming a `plan`, 50 tasks, and
  sustained update rates. If posted blocks don't render, the card falls back to a short stream
  for each state change, and this plan is revised before PR 4.
- **Tests.** The view projection and default card are pure functions, so they get unit tests.
  The collector's post-then-update behavior gets a scenario test against a fake Slack API through
  `slackChannel({ api })`. The renderer chain gets unit tests for ordering, `next(data)`, and the
  private sign-in constraint. Per the `test-audit` skill, eve adds no test that restates the code.

## Follow-ups

- **Agent sessions.** Move status to `agents.sessions.setStatus`, which keeps `processing` for an
  hour, and map Slack's native stop button (`agent_session_stopped`) to `session.cancel()`. New
  Slack apps must use the agent messaging experience, so this needs its own manifest and
  migration plan.
- **Streamed replies.** Stream reply text with `chat.startStream` for turns that start no tasks.
- **Stop controls on the card.** Add a `context_actions` stop button that cancels the turn. Letting
  a person cancel a single task needs a public API that doesn't exist yet.
- **Sources.** Let tool labels return URL sources for the card's `sources` field.

## Decisions

When a choice was open, clarity for the person reading the thread decided it.

1. **Failures show their reason.** A bare `Failed` leaves people guessing, and the reply often
   repeats the reason anyway. Rows show the first line of the error in every channel.
2. **Stopped rows never look successful.** A cancelled task uses `error` with `Stopped`, and the
   plan title counts it apart from failures.
3. **The card has a predictable place.** The root posts it inline on the first `task.started`, so
   it always sits where the work began. The collector only updates it.
4. **Acknowledging is rendering, and it is immediate.** `Thinking…` belongs to `received` in the
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
