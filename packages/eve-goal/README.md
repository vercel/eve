# eve/extensions/goal

`eve/extensions/goal` gives an eve session a durable goal. After every turn, a judge reads the objective and the evidence the turn surfaced and decides whether the goal is met. If it isn't, the extension starts the next turn on its own with hook `ctx.followUp()`, guided by the judge's reason, until the goal is met, judged impossible, paused, or out of budget.

It ships inside the `eve` package. This private `@eve/goal` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/goal/extension` and publishes it as `eve/extensions/goal`.

## Mount

```ts
// agent/extensions/goal.ts
import goal from "eve/extensions/goal";

export default goal({ model: "openai/gpt-6-luna-fast", maxRuns: 30, maxCostUsd: 25 });
```

| Option        | Default                    | Meaning                                                                                                                              |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `model`       | `"openai/gpt-6-luna-fast"` | The default judge's model: an AI Gateway model ID or a model instance.                                                               |
| `judge`       | a structured-output call   | Replaces the default judge: `(input) => Promise<{ verdict, reason, notes? }>`.                                                       |
| `maxRuns`     | `50`                       | Follow-ups a goal may queue before it pauses.                                                                                        |
| `maxCostUsd`  | unlimited                  | Model spend the agent's turns may add, as `usage(view).total.costUsd`, before the goal pauses. The judge's own calls aren't counted. |
| `setApproval` | none                       | An approval policy for `goal__set`, such as `always()`.                                                                              |

A model ID routes through AI SDK's default provider, AI Gateway, so the deployment needs Gateway credentials. To judge with eve's provider authentication instead, pass a model instance such as `openai("gpt-6-luna-fast")` from `eve/models/openai`.

## What it contributes

Mounted as `goal`:

- `goal__set` sets or replaces the objective. It's the only lifecycle action the model takes on its own, and needs approval when `setApproval` is set.
- `goal__status` reports the objective, status, runs, and the judge's last reason.
- `goal__pause`, `goal__resume`, and `goal__clear` require the person's approval. Resume grants a fresh run and spend budget.
- A dynamic system instruction shows the active objective and the judge's last reason before every model call.
- A `turn.settled` hook that judges the turn and continues the session.

The model can never mark a goal met; only the judge can.

## Loop

After each completed turn of an active goal, the hook pauses the goal when:

- the turn failed or was cancelled,
- two of the goal's own follow-up turns in a row made no tool calls, or
- the judge failed.

Otherwise the judge returns `met`, `impossible`, or `continue`. Every completed turn is judged, so one that finishes the work at a limit is still met. On `continue`, the goal pauses instead if it reached `maxRuns` or its spend reached `maxCostUsd`; otherwise the hook follows up with `Continue working toward the goal. <reason>` as the next message. A person's message always wins: the follow-up yields to any turn that starts first, and that turn is judged next with their input in view, so "stop" or a change of direction reaches the verdict.

The judge sees the turn's input, its reply, its settled tool calls, and the `notes` it wrote for the previous verdict, not the whole transcript. The notes carry proof from earlier turns forward. Prove progress with tool output.

## Validate

```sh
pnpm --filter @eve/goal typecheck
pnpm --filter @eve/goal test
```
