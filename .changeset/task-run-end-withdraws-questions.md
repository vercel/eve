---
"eve": patch
---

A relayed question or approval that can no longer be answered now emits `input.resolved` with `outcome: "cancelled"`. This applies when a task run or workflow tool call finishes while its `ctx.ask()` question is pending, and when a turn is cancelled while the session relays a request from a task, workflow tool call, or subagent. Previously the request was dropped silently, so channels and `useEveAgent` UIs kept offering it even though an answer could no longer reach anyone.
