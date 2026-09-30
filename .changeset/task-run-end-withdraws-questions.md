---
"eve": patch
---

A question or approval that a task run or workflow tool call relays, from its own `ctx.ask()` or from a session it opened with `ctx.agent`, now emits `input.resolved` with `outcome: "cancelled"` when that run finishes before anyone answers. Every question or approval a session relays does the same when the turn is cancelled. Previously these requests were dropped silently or left in place, so channels and `useEveAgent` UIs kept offering them even though no answer could reach anyone.
