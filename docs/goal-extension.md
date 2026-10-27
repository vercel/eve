---
title: "Goal Extension"
description: "Give a session a durable goal that a judge checks after every turn, and let the agent keep working until it's met."
---

`eve/extensions/goal` keeps an agent working toward an objective across turns without someone prompting each step. After every turn, a judge reads the objective and what the turn surfaced, and decides whether the goal is met. If it isn't, the extension starts the next turn on its own, guided by the judge's reason. It stops when the goal is met, judged impossible, paused, or out of budget. The extension ships inside the `eve` package and is built on hook [`ctx.followUp()`](./guides/hooks#follow-up-a-turn-from-a-hook).

## Mount the extension

```ts title="agent/extensions/goal.ts"
import goal from "eve/extensions/goal";

export default goal({ maxRuns: 30, maxCostUsd: 25 });
```

| Option       | Default                    | Meaning                                                                                                             |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `model`      | `"openai/gpt-6-luna-fast"` | The default judge's model: an AI Gateway model ID or a model instance.                                              |
| `judge`      | a structured-output call   | Replaces the default judge: `(input) => Promise<{ verdict, reason }>`.                                              |
| `maxRuns`    | `50`                       | Follow-ups a goal may queue before it pauses.                                                                       |
| `maxCostUsd` | unlimited                  | Model spend, in US dollars, the agent's turns may add before the goal pauses. The judge's own calls aren't counted. |

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

Setting a goal is the only lifecycle action the model takes on its own. The model can't mark a goal met: only the judge can. While a goal is active, a dynamic system instruction shows the objective and the judge's last reason before every model call.

## How the loop decides

After each turn of an active goal settles, the extension pauses the goal when:

- the turn failed or was cancelled,
- two of the goal's own follow-up turns in a row made no tool calls, or
- the judge failed.

Otherwise the judge returns `met`, `impossible`, or `continue` with a reason. Every completed turn is judged, so one that finishes the work at a limit is still met. On `continue`, the goal pauses instead if it reached `maxRuns` or its spend reached `maxCostUsd`; otherwise the extension follows up with `Continue working toward the goal. <reason>` as the session's next message. The model reads it with a note that the hook sent it, not a person.

The judge sees the turn's input, its reply, and its settled tool calls, not the whole transcript, so the agent should prove progress with tool output. A person's message always wins: the continuation yields to any turn that starts first, and that turn is judged next with the person's input in view. A "stop" or a change of direction reaches the verdict.

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

The judge receives `{ objective, input, reply, calls, abortSignal }` and returns `{ verdict, reason }`. Throwing pauses the goal.
