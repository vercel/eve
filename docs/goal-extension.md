---
title: "Goal Extension"
description: "Give a session a durable goal that a judge checks after every turn, and let the agent keep working until it's met."
---

`eve/extensions/goal` keeps an agent working toward an objective across turns without someone prompting each step. After every turn, a judge reads the objective and what the turn surfaced, and decides whether the goal is met. If it isn't, the extension starts the next turn on its own, guided by the judge's reason. It stops when the goal is met, judged impossible, paused, or out of budget. The extension ships inside the `eve` package and is built on hook [`ctx.continue()`](./guides/hooks#continue-a-turn-from-a-hook).

## Mount the extension

```ts title="agent/extensions/goal.ts"
import goal from "eve/extensions/goal";

export default goal({ maxRuns: 30, maxCostUsd: 25 });
```

| Option        | Default                    | Meaning                                                                                                             |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `model`       | `"openai/gpt-6-luna-fast"` | The default judge's model: an AI Gateway model ID or a model instance.                                              |
| `judge`       | a structured-output call   | Replaces the default judge: `(input) => Promise<{ verdict, reason, notes? }>`.                                      |
| `maxRuns`     | `50`                       | Continuations a goal may queue before it pauses.                                                                    |
| `maxCostUsd`  | unlimited                  | Model spend, in US dollars, the agent's turns may add before the goal pauses. The judge's own calls aren't counted. |
| `setApproval` | none                       | An approval policy for the model's `goal__set` calls, such as `always()` from `eve/tools/approval`.                 |

A model ID goes through AI SDK's default provider, AI Gateway, so the deployment needs Gateway credentials such as `AI_GATEWAY_API_KEY` or Vercel OIDC. To judge with eve's provider authentication instead, pass a model instance such as `openai("gpt-6-luna-fast")` from `eve/models/openai`.

## Tools and instructions

Mounted as `goal`, the extension contributes:

| Tool           | Use                                                                         |
| -------------- | --------------------------------------------------------------------------- |
| `goal__set`    | Sets or replaces the session's objective, up to 4,000 characters.           |
| `goal__status` | Reports the objective, status, runs, and the judge's last reason.           |
| `goal__pause`  | Pauses the goal. Requires the person's approval.                            |
| `goal__resume` | Resumes a paused goal with a fresh run and spend budget. Requires approval. |
| `goal__clear`  | Clears the goal. Requires approval.                                         |

Setting a goal is the only lifecycle action the model takes on its own, unless you pass `setApproval`. The model can't mark a goal met: only the judge can. While a goal is active, a dynamic system instruction shows the objective and the judge's last reason before every model call.

## Require approval to set a goal

By default, the model can start a goal whenever it decides the person asked it to keep going. To have the person confirm every goal first, pass an approval policy:

```ts title="agent/extensions/goal.ts"
import goal from "eve/extensions/goal";
import { always } from "eve/tools/approval";

export default goal({ setApproval: always() });
```

Any [approval policy](./human-in-the-loop#approvals) works, including `once()` or your own function. It receives the call's `{ objective }` as its input.

## How the loop decides

After each turn of an active goal settles, the extension pauses the goal when:

- the turn failed or was cancelled,
- two of the goal's own continuation turns in a row made no tool calls, or
- the judge failed.

Otherwise the judge returns `met`, `impossible`, or `continue` with a reason. Every completed turn is judged, so one that finishes the work at a limit is still met. On `continue`, the goal pauses instead if it reached `maxRuns` or its spend reached `maxCostUsd`; otherwise the extension continues with `Continue working toward the goal. <reason>` as the session's next message. The model reads it with a note that it was sent automatically, not by a person.

The judge sees the turn's input, its reply, and its settled tool calls, not the whole transcript, so the agent should prove progress with tool output. With each verdict, the judge also writes short `notes` on what the evidence has proved so far, and reads them back on the next turn. A check that passed in an earlier turn still counts when a later turn only reports that it's done. A person's message always wins: the continuation yields to any turn that starts first, and that turn is judged next with the person's input in view. A "stop" or a change of direction reaches the verdict.

Continuation turns are ordinary turns, so approvals, task waiting, and `limits.sessionUsage` apply unchanged. Mount the extension on an agent that people talk to directly. In a [subagent](./subagents), the caller receives the first turn's reply and doesn't wait for the continuations.

## Write your own judge

Pass `judge` to verify with your own checks, such as running a test suite, or to call a model of your choice:

```ts title="agent/extensions/goal.ts"
import goal from "eve/extensions/goal";

export default goal({
  judge: async ({ objective, reply }) =>
    reply.includes("All tests pass.")
      ? { verdict: "met", reason: "The suite passed." }
      : { verdict: "continue", reason: `Run the test suite and fix what fails: ${objective}` },
});
```

The judge receives `{ objective, notes, input, reply, calls, abortSignal }` and returns `{ verdict, reason, notes? }`. `notes` is the value the judge returned for an earlier turn of this goal. Return new `notes` to replace them, or omit them to keep the current ones. Throwing pauses the goal.
