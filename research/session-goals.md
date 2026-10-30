---
issue: https://github.com/vercel/eve/issues/5456
status: proposed
last_updated: "2026-10-29"
---

# Session goals

## Summary

Coding harnesses now ship `/goal`: a durable objective attached to a conversation. After each turn, a judge decides whether the objective is met. If not, the agent starts another turn on its own, guided by the judge's reason, until the goal is met, judged impossible, paused, or out of budget. Authors building long-running eve agents ask for the same loop.

eve already has most of the pieces: durable per-session state, per-call dynamic instructions, `turn.settled` hooks, turns that wait for their tasks, and durable sessions that park without compute. One piece is missing. Nothing that observes a settled turn can start the next one in the same session. Hooks can only observe and `cancel()`, task results never start a turn, and dynamic schedules start fresh sessions instead of steering an existing one.

This plan adds one core primitive, a same-session `ctx.continue()` on `turn.settled` hook handlers, and builds goals on top of it as an extension. The core stays lean: goals are a policy, and continuing a turn is the mechanism.

## Prior art

Several coding agents and agent frameworks ship goal loops. They differ mainly in who judges and what triggers the next turn:

| Pattern                    | Judge                                                                                                                      | Trigger                                       | Safety                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Separate judge after turns | A small, fast model reads the condition and evidence; met, not met, or impossible, with a reason that steers the next turn | A stop hook after every turn                  | Stops after several turns without tool use; skips judging while background work runs  |
| Self-assessed completion   | The working model marks the goal complete through a tool, only on evidence                                                 | A continuation prompt at idle boundaries only | Thread-scoped budget; interruptions pause; no continuation while user input is queued |
| Judge inside the loop      | An LLM-as-judge scorer, optionally with read-only verification tools                                                       | A step in the agent loop before it returns    | Run budget (commonly 50); exhaustion pauses and is resumable                          |
| Blocked stop               | None; the agent audits its own work against a deliverables checklist                                                       | A stop hook refuses premature turn ends       | Often no iteration cap; waits for subagents and background tasks                      |

The shared shape is: durable objective per thread, a trigger at turn end, a judge, a budget with a no-progress guard, pause, resume, and clear, and waiting for background work. eve already provides the last item: [turns wait for their tasks](../docs/tools/tasks.md#turns-wait-for-their-tasks).

## Core: `ctx.continue()` from hooks

Today a hook acts on the session in exactly one way: `ctx.cancel(reason?)`. The handler pushes a command, `queueCommands` stores it in reactions state as an intent bound to the **active turn**, and `actOnCancels` stops that turn after the commit. Intents are turn-scoped by construction: a request made between turns is dropped. On `turn.settled` there is no active turn, so nothing a hook asks for there can take effect.

A goal continuation is a message into the current conversation, so it takes what every send takes: `MessageContent` and the shared send options. It isn't a send, though. Everywhere else in eve, `send` (`Session.send`, `from().send`, `to().send`, Slack's `ctx.send`) dispatches into the inbox now and returns a `Promise<Delivery>`. A hook runs inside a session step, its message can't be admitted until the handler returns, and it is dropped if other input starts a turn first. There is no receipt to return. So it gets its own verb, `continue`, with the shared types and a small synchronous result:

```ts
type HookContinueOptions = Pick<SessionSendOptions, "context"> &
  Partial<Pick<SessionSendOptions, "auth">>;

type HookContinueResult =
  | { readonly queued: true }
  | {
      readonly queued: false;
      readonly reason: "not-settled" | "not-completed" | "already-queued" | "auth-conflict";
    };

// Only `turn.settled` and `*` handlers receive it: HookContext<TKey> adds it from a total map
// over hook event keys, so a handler on any other key can't call it.
interface HookContinue {
  continue(message: MessageContent, options?: HookContinueOptions): HookContinueResult;
}
```

Defaults fill what a hook should not have to know. There's no `idempotencyKey`: the continuation is recorded with the step that settled the turn, which a retry never runs handlers for again, and its delivery's key derives from the settled turn. `auth` is omitted: the continuation names no sender, and the turn runs as the session's current identity, so a shared thread doesn't attribute the hook's words to whoever spoke last. `turnPolicy` is not an option: a continuation always queues. `history`, `outputSchema`, and `title` are omitted because the session, its history, and its title already exist.

The smallest use needs no model judge. This hook keeps the agent working until the test suite passes, for at most ten continuations:

```ts title="agent/hooks/until-green.ts"
import { defineState } from "eve/context";
import { defineHook } from "eve/hooks";

const attempts = defineState("until-green.attempts", () => 0);

export default defineHook({
  events: {
    async "turn.settled"(event, ctx) {
      if (event.data.outcome !== "completed") return;
      const sandbox = await ctx.getSandbox();
      const test = await sandbox.run({ command: "pnpm test --reporter=dot" });
      if (test.exitCode === 0 || attempts.get() >= 10) {
        attempts.update(() => 0);
        return;
      }
      attempts.update((n) => n + 1);
      ctx.continue(
        `Tests still fail. Fix them without editing test files.\n\n${test.stdout.slice(-2000)}`,
      );
    },
  },
});
```

Semantics reuse the `ctx.cancel()` command path where they can, and differ where the target turn differs:

|                 | `cancel(reason?)`                        | `continue(message, options?)`                                          |
| --------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| Targets         | The running turn                         | The next turn                                                          |
| Eligible on     | Events while a turn runs                 | `turn.settled` and `*` handlers; a completed turn, or one it cancelled |
| Stored as       | An intent keyed by the active `turnId`   | A session-level intent with no turn, keyed by the settled `turnId`     |
| Consumed by     | `actOnCancels` after the commit          | The idle wait in `nextTurnDelivery`, when nothing is queued            |
| Effect          | `turn.cancelled`, then `session.waiting` | A message delivery that starts a normal turn                           |
| Competing input | The first cancel wins                    | Yields to any other turn, cancel, clear, or reset; survives compaction |

- **Recorded now, applied later.** It returns `{ queued }` synchronously: it is recorded during the handler and admitted after the event's hooks return, so retries and workflow replay stay deterministic. Like `cancel()`, calling it after the handler settled throws. If the handler throws, its commands are discarded with the rest of its requests.
- **Fails closed on events, in the types.** A total map over hook event keys decides which handlers receive `continue`, so a new event does not compile until it is classified, and a `turn.started` handler has no `continue` to call. A `*` handler receives it for every event and gets `{ queued: false, reason: "not-settled" }` off `turn.settled`; a `failed` turn, or one a person or another hook cancelled, returns `not-completed`.
- **Cancel, then redirect.** A hook that cancelled the turn can continue it, for example to cancel an agent that started editing test files and tell it not to. Only that hook can: a person's `session.cancel()` must still stop the session, and letting another hook continue it would let a guard and a goal loop against each other. Failed turns can't be continued yet: a failure that repeats, such as `SESSION_USAGE_LIMIT_REACHED`, would turn a retry hook into a loop of failing turns.
- **One next turn per settled turn, shared by hooks.** The intent is keyed by the settled `turnId`. Each hook that continues the turn adds a payload to its one delivery, in hook order, the way the input queue coalesces one principal's consecutive messages into a turn, so a goal hook and a lint hook both contribute and load order can't starve either. A hook asking twice returns `already-queued`. One delivery acts for one principal: a continuation that acts for a different principal than the queued one returns `auth-conflict`, where omitted `auth` means the session's current identity, since it couldn't run as a separate turn without yielding to the first.
- **Queues, never steers, and yields.** The intent belongs to the turn that settled. `nextTurnDelivery` admits it only when the input queue and inbox are empty. Any other turn that starts first discards it: a person's message, an answer, a schedule send, or another hook's continuation. A compaction leaves it queued, so it cannot stall a goal. `cancel`, `clear`, and `reset` discard it, so a person can always stop a loop from any channel, and a cleared session doesn't start on stale guidance. An expiry ends the session with the continuation unsent. `queued: true` means recorded; yielding happens later, and the hook sees the turn that won settle next.
- **Arrives as a marked message delivery.** `delivery.admitted` records `source: { channel, hook: "<slug>" }` and no principal unless the hook passes `auth`. `hook` is an optional field on the existing channel source, not a new source variant, so readers that switch on `source` still match it as a channel delivery. The delivery passes through the owning channel's `deliver` hook like any other message. The model receives the message and `context` as the hook passed them. From `source.hook`, intake records a durable `context.instruction` ahead of the message saying it was sent automatically, not by a person, so the prompt the model reads matches history and measured prompt sizes stay exact. Channels and UIs can render hook-origin turns distinctly.
- **Same session only.** A continuation never creates or reaches another session, so the delegated-session refusal on `ctx.to()` in #5096 does not apply: that refusal exists because a new session would outlive the delegation and act for the caller, and a message into the running session creates nothing new. Whether the caller waits for those extra turns is an open question below.
- **No new settlement path.** The continuation runs as a normal turn, so approvals, task waiting, and `limits.sessionUsage` apply unchanged. Unattended sessions keep failing with `SESSION_USAGE_LIMIT_REACHED` instead of prompting.
- **Failures between turns are logged.** A hook that throws during a turn fails that turn. On `turn.settled` there is no turn left to fail, so `reportReactionFailure` logs the error and nothing continues.

Yielding is a fixed rule, not an option. For a goal it loses nothing: the hook runs after every `turn.settled`, including the person's turn, so their turn becomes the next goal iteration and is judged with their input in view. Queuing behind other input instead would deliver guidance written before the person spoke (after "stop" or "try the other approach"), add a turn per interjection that spends budget, and let channels that batch adjacent same-auth messages merge stale guidance into the person's message. Hooks that must always deliver a message, such as notifications, should use a channel send instead.

Extension compatibility is checked against the eve version an extension was built with, so `continue` needs no separate contract bump.

## Extension: goals

Goals ship as an extension built only on public APIs plus hook `ctx.continue()`.

```mermaid
flowchart LR
  Set["goal__set tool"] --> State[("goal state")]
  State --> Instr["dynamic instructions: current objective"]
  Turn["turn.settled hook"] --> Judge{"judge"}
  Judge -->|met| Done["status: met"]
  Judge -->|impossible| Failed["status: impossible"]
  Judge -->|continue, budget left| Cont["ctx.continue(reason)"]
  Judge -->|budget spent or no progress| Paused["status: paused"]
```

- **State.** `defineState("goal")` holds `{ objective, status, runs, maxRuns, idleRuns, lastReason, costAtStart }`. A turn is a continuation when its deliveries' `source.hook` is set, so state doesn't track it. `status` is `active`, `paused`, `met`, or `impossible`. One goal per session; setting a new one replaces it.
- **Tools.** Names derive from paths and the mount adds the prefix. `goal__set` sets or replaces the objective (up to 4,000 characters) and is the only lifecycle action the model may take on its own. `goal__status` reports status, runs, spend, and the last reason. `goal__pause`, `goal__resume`, and `goal__clear` are for the person; channels can map them to a `/goal` command. The model can never mark a goal met.
- **Instructions.** A `defineDynamic` instruction shows the objective, the run count, and the judge's last reason before every model call while the goal is active.
- **Judge.** A structured-output model call returns `{ verdict: "met" | "continue" | "impossible", reason }`. It reads the objective, the input the turn consumed (the parts on its `delivery.consumed`), the turn's reply (`reply(ctx.view, turnId)`), and its settled calls (`calls(ctx.view, { turnId })`). Reading the input lets a person's "stop" or change of direction reach the verdict. Hooks do not receive assembled history, so the judge sees evidence the turn surfaced, not the whole transcript. `decide()` is not enough on its own because it returns no prose rationale, and the reason is what steers the next turn.
- **Budget and guards.** Default `maxRuns` is 50; an optional spend cap compares `usage(ctx.view).total.costUsd` with `costAtStart`. Reaching either pauses with a reason. Two consecutive continuation turns with no tool calls pause the goal. A `failed` or `cancelled` turn pauses it. A judge error pauses it: unattended sessions should not burn budget on a broken judge.

### Sketch

A consumer mounts it like any extension:

```ts title="agent/extensions/goal.ts"
import goal from "@eve/goal";

export default goal({ judge: "openai/gpt-6-luna", maxRuns: 30, maxCostUsd: 25 });
```

The judge hook carries the policy. State, tools, and instructions are ordinary contributions:

```ts title="extension/hooks/judge.ts"
import { calls, deliveries, reply, usage } from "eve/events";
import { defineHook } from "eve/hooks";
import extension from "../extension";
import { judge } from "../lib/judge";
import { goal } from "../lib/state";
import { turnInput } from "../lib/turn-input";

export default defineHook({
  events: {
    async "turn.settled"(event, ctx) {
      const current = goal.get();
      if (current?.status !== "active") return;
      const pause = (reason: string) =>
        goal.update((g) => g && { ...g, status: "paused", lastReason: reason });

      if (event.data.outcome !== "completed") return pause(`Turn ${event.data.outcome}.`);
      const { turnId } = event.data;
      const turnCalls = calls(ctx.view, { turnId });
      const continued = deliveries(ctx.view, { turnId }).every(({ source }) => source?.hook);
      const idle = continued && turnCalls.length === 0 ? current.idleRuns + 1 : 0;
      if (idle >= 2) return pause("Two continuation turns made no tool calls.");
      if (current.runs >= current.maxRuns) return pause(`Reached ${current.maxRuns} runs.`);
      const spent = (usage(ctx.view).total.costUsd ?? 0) - current.costAtStart;
      if (spent >= extension.config.maxCostUsd) return pause(`Spent $${spent.toFixed(2)}.`);

      const verdict = await judge({
        objective: current.objective,
        input: turnInput(ctx.view, turnId), // parts from the turn's delivery.consumed
        reply: reply(ctx.view, turnId),
        calls: turnCalls,
      }).catch(() => undefined);
      if (verdict === undefined) return pause("The goal judge failed.");
      if (verdict.verdict !== "continue") {
        return goal.update(
          (g) => g && { ...g, status: verdict.verdict, lastReason: verdict.reason },
        );
      }
      goal.update(
        (g) =>
          g && {
            ...g,
            runs: g.runs + 1,
            idleRuns: idle,
            lastReason: verdict.reason,
          },
      );
      ctx.continue(`Continue toward the goal. ${verdict.reason}`);
    },
  },
});
```

```ts title="extension/instructions.ts"
import { defineDynamic, defineInstructions } from "eve/instructions";
import { goal } from "./lib/state";

export default defineDynamic(() => {
  const current = goal.get();
  if (current?.status !== "active") return null;
  return defineInstructions({
    role: "system",
    content: [
      `<goal runs="${current.runs}/${current.maxRuns}">${current.objective}</goal>`,
      current.lastReason && `<last_judgement>${current.lastReason}</last_judgement>`,
      "Work toward the goal. Prove progress with tool output; the judge only sees what this turn surfaces.",
    ]
      .filter(Boolean)
      .join("\n"),
  });
});
```

`extension/tools/set.ts` (mounted as `goal__set`) validates the objective and writes `{ status: "active", runs: 0, idleRuns: 0, costAtStart }`, reading `costAtStart` from `usage` in the tool's session view. `extension/lib/judge.ts` makes one structured-output model call with the configured judge model and returns `{ verdict, reason }`.

## Alternatives considered

- **Loop inside a workflow tool.** Works today: a `goal_run` workflow tool loops `ctx.agent(...).send()` and judges each result in a step. But the work runs in a child session with fresh history, and the parent turn stays open for the whole goal. Useful as an interim recipe, not as the goal primitive.
- **Self-call through `eve/client`.** A `turn.settled` hook calls `new Client(...).sessions.attach(id).send(..., { turnPolicy: "queue" })` against its own deployment. It adds an auth and base-URL dependency and race risk for something the runtime can do directly.
- **`ctx.to()` back into the current conversation.** With #5096, tools get `ctx.to(channel, target).send()`. Slack's `receive()` with an existing `threadTs` sends through `from(<thread>)`, which reaches the session that owns the thread, so a tool in a Slack thread can queue its own next turn:

  ```ts
  await ctx.to(slack, { channelId, threadTs }).send("Continue toward the goal.", {
    auth: ctx.session.auth.current,
    turnPolicy: "queue",
    idempotencyKey: `${ctx.session.id}:${ctx.callId}`,
  });
  ```

  That is a usable interim recipe once the stack lands, but not the goal primitive. It is channel-specific: the extension would need the consumer's channel module and a per-channel target mapping, and sessions without an addressable channel cannot use it. Delegated sessions are refused by design. It is only on tools, so continuation depends on the model calling a checkpoint tool rather than on a judge that always runs. Giving hooks `ctx.to()` would fix the last point but not the first two.

- **`ctx.send(message)`.** An earlier draft of this plan. Familiar, and it matches Slack's thread-bound `ctx.send()`, but every other `send` dispatches now and returns a `Promise<Delivery>`. A hook's message can't be admitted until the handler returns and can be dropped, so the shared name would promise a receipt it can't give. `continue` keeps the shared message and option types under a verb that says what it does. It's a reserved word, but property names may be reserved words, so `ctx.continue()` works; only destructuring it doesn't. `followUp` was the other candidate, and an earlier name for it.
- **Schedules.** Dynamic schedules start fresh sessions and do not steer an existing conversation. A minute-granularity dispatcher adds latency and an external store.
- **Stop hook that blocks turn end, or a judge inside the harness loop.** Matches the blocked-stop and in-loop patterns above, but changes `harness/` turn settlement. Continuation after settlement gets the same behavior with a smaller core change.

## Open questions

- In a delegated session, the caller receives the child's reply when its turn settles. A continuation there starts turns nobody waits for. Goals in subagents likely need continuations to keep the delegated task open until the child stops continuing.
- Whether a continuation should support a delay (`continue(message, { after })`) for goals that wait on external events, using a durable sleep in the session workflow.
- How first-party channels (Slack, web chat) should present hook-origin turns.
