---
"eve": minor
---

A `defineDynamic` function in `agent/tools/` can now return `defineWorkflowTool`, so a session can be offered a workflow tool conditionally or with its own description and schemas.

Declare the entry point (`execute`, `task`, or `serve`) as a top-level `async function` that starts with `"use workflow"`, and pass it to `defineWorkflowTool` by reference. eve compiles it when it builds the agent, so it can't read variables from the `defineDynamic` function; it gets the call's input and `ctx`.
