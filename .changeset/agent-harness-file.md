---
"eve": patch
---

Add an experimental `agent/harness.ts`, whose `defineHarness((ctx) => ({ agent, history, next }))` decides how the agent's turns run.

It can set the model, tools, and instructions each model call gets, replace compaction, and continue a turn with a note before it ends. `agent.tools` and `agent.instructions` are everything the model gets besides eve's own `eve__` tools, with a function form that receives what the agent declares.
