---
"eve": patch
---

A workflow tool's `ctx.ask()` question now emits `input.resolved` with `outcome: "cancelled"` when the task run or workflow tool call that asked finishes before anyone answers, and every question or approval a session relays does when the turn is cancelled. Previously these requests were dropped silently, so channels and `useEveAgent` UIs kept offering them even though no answer could reach the work that asked.
