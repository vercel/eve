---
"eve": patch
---

Add an experimental `agent/harness.ts`, whose `defineHarness((ctx) => ({ agent, history, next }))` decides how the agent's turns run.

`agent` sets the model, tools, and instructions each model call gets. The harness composes them from `declared(ctx)`, what the agent's files declare as data, and `builtins(ctx)`, eve's `eve__` tools and its default prompt's renderers. `agent.instructions` is the whole system prompt and `agent.tools` every tool the model is offered, so eve's own tools and prompt sections are there only when the harness returns them. A declared tool keeps its name and approval; a copy may change its description. The agent's declared values are evaluated only when the harness asks for them, or leaves a field to eve.

`history` runs before every model call and for `session.compact()`, and what it returns becomes the session's history. `ctx.size` gives the call's estimated tokens and the model's window, `ctx.compact` marks a `session.compact()`, and `ctx.summarize(history)` is eve's summarizer.

`next` runs after each model call and can continue the turn with a note before it ends.
