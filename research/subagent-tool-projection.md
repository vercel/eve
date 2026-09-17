---
issue: TBD
status: in-progress
last_updated: "2026-09-17"
---

# Subagent tool projection

## Summary

Separate executable child-agent registration from model-tool projection. A subagent remains addressable through `ctx.agent(name, input)` even when its derived model tool is disabled. This lets an authored workflow tool use JEV or another deterministic router to select specialists without exposing those specialists to the conversational model.

## Authoring API

An agent controls its own derived tool with `tool`:

```ts
// agent/subagents/researcher/agent.ts
export default defineAgent({
  description: "Investigate and explain ambiguous questions.",
  model: "anthropic/claude-opus-4.8",
  tool: false,
});
```

On the root agent, `tool: false` disables the built-in `agent` self-delegation tool. A same-named tool slot can make the same selection from the parent layer:

```ts
// agent/tools/researcher.ts
import { disableTool } from "eve/tools";

export default disableTool();
```

The second form removes the derived `researcher` tool but not the `researcher` child-agent node. An authored tool in the same slot may instead become the model-facing wrapper when the subagent sets `tool: false`.

## Semantics

- `tool` defaults to `true` for root, local, remote, workspace, and dynamically selected agents.
- Root `tool: false` removes the built-in `agent` tool unless an authored `agent/tools/agent.ts` overrides that slot.
- Subagent `tool: false` suppresses only its model-tool projection. Workflow `ctx.agent()` continues to resolve the child from the complete registry.
- A same-named `disableTool()` suppresses a declared subagent's projection or the root built-in `agent` tool.
- A same-named authored tool and subagent may coexist only when the subagent's tool projection is disabled. The authored tool owns the model name; `ctx.agent(name, input)` owns the child-agent name.
- Hidden subagents retain their description, execution, authorization, task lifecycle, tracing, limits, output schema, and continuation behavior.
- A nullish dynamic subagent selection remains unavailable to every caller. `tool: false` is visibility, not availability.

## Runtime boundary

Each compiled agent node records its selected tools and source-composition decisions. Runtime graph construction derives disabled tool names from that existing composition, always registers every resolved subagent by name and node id, and prepares a subagent model tool only when the child has not set `tool: false` and the parent has not disabled the same-named tool slot. Workflow `ctx.agent()` resolves from the full registry rather than the prepared model-tool list.
