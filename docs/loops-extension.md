---
title: "Loops Extension"
description: "Notice when a turn repeats the same tool calls without progress, nudge the model to change approach, then stop the turn."
---

`eve/extensions/loops` notices when a turn repeats the same tool calls without making progress. It first tells the model which loop it is in and asks it to change its approach. If the turn loops again, the extension stops it, before the loop uses up the turn's steps, tokens, or budget. The extension ships inside the `eve` package, adds no tools, and changes nothing for a turn that doesn't loop.

## Mount the extension

```ts title="agent/extensions/loops.ts"
import loops from "eve/extensions/loops";

export default loops({});
```

Every setting is optional:

```ts title="agent/extensions/loops.ts"
import loops from "eve/extensions/loops";

export default loops({
  // How many of the turn's most recent calls the checks look at. Default 10.
  window: 10,
  // The same call (same tool, same input) made this many times within `window`. Default 5.
  repeatedCall: 5,
  // The same call returning the same result this many times in a row. Default 3.
  repeatedResult: 3,
  // Two different calls made in turn, A-B-A-B, for this many cycles. Default 3.
  alternatingCalls: 3,
  // Loops a turn is nudged about before the next one stops it. 0 stops at the first loop. Default 1.
  maxNudges: 1,
});
```

Set a check to `false` to turn it off. A check that could never fire within `window` fails at mount.

## What counts as a loop

After every call settles, the extension checks the turn's recent calls, newest last, in this order:

| Pattern             | Reported when                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `repeated-result`   | The newest call returned the same result as each of the last `repeatedResult` identical calls.     |
| `alternating-calls` | The last calls alternate between two different calls for `alternatingCalls` A-B cycles.            |
| `repeated-call`     | The newest call appears `repeatedCall` times within the last `window` calls, whatever it returned. |

Inputs and outputs are compared as JSON with sorted keys, so key order never makes two calls look different. A failed call's result is its error, so a call that keeps failing the same way is a `repeated-result` loop. Calls that wait on or cancel [tasks](./tools/tasks) don't count.

Only the running turn's calls count, and the calls that formed a loop are then forgotten, so the same loop has to build up again before it counts a second time. Each [subagent](./subagents) session is checked on its own.

A tool you poll until a job finishes is a `repeated-result` loop after 3 polls that return the same status. If your agent polls on purpose, raise `repeatedResult`, turn it off, or have the tool return something that changes between polls, such as the elapsed time.

## Nudge, then stop

The first `maxNudges` loops in a turn nudge the model. The nudge is a [dynamic system instruction](./instructions#dynamic-instructions) that names the loop, for example:

```text
The last 3 calls to `read_file` used the same input and returned the same result. Repeating it will not change the outcome. Change your approach, or explain what is blocking you.
```

The model sees it on every remaining model call of the turn. Because it is a system instruction, tool output can't imitate it, and compaction can't rewrite it.

The next loop stops the turn with [`ctx.cancel()`](./guides/hooks#cancel-the-running-turn-from-a-hook), before the next model call. The turn ends with `outcome: "cancelled"`, its `cause` names the extension's hook, and the cancel reason says which loop it was. With the defaults, a turn stuck on one failing call is nudged after 3 calls and stopped after 6.

The extension keeps its record in [state](./concepts/state), so it survives step boundaries and redeploys within the turn.
