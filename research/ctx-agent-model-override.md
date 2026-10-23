---
issue: TBD
status: implemented
last_updated: "2026-10-20"
---

# `ctx.agent` model override

## Goal

Let an authored workflow choose the model for a local agent session without exposing that choice in a model-facing agent tool or duplicating the agent as one declared subagent per model.

```ts
const worker = ctx.agent("agent", {
  model: "anthropic/claude-opus-5.5",
});

const response = await worker.send("Review the migration plan.");
```

The option binds to the session, not an individual message. Every turn sent through the returned handle uses the selected model. Omitting it preserves the target agent's configured model behavior.

A root can also opt into a model-facing `agent` variant whose input includes the model:

```ts
// agent/tools/agent.ts
export { agentWithModel as default } from "eve/tools/agent";
```

## Semantics

- The override applies to local targets, including the built-in root copy and declared or dynamic subagents.
- It replaces only the turn model. Instructions, tools, skills, connections, sandbox behavior, limits, reasoning, and explicit compaction configuration continue to come from the target agent.
- A selection object can set model-specific reasoning, context-window metadata, and provider options, using the same serializable shape as a durable dynamic model selection.
- The model must be an AI Gateway model id. A live AI SDK `LanguageModel` cannot cross the durable workflow boundary.
- Remote targets reject the option because the receiving deployment owns their model configuration.
- The selected model is fixed when the session opens. Later `send()` calls cannot change it.

## Design

`ctx.agent(name, options?)` stores the authored selection on the lazy session handle. The first `send()` resolves the target. For a local target, eve normalizes the selection into the same durable runtime model reference used by dynamic subagents and dynamic model resolvers, then carries a narrow session override into the child workflow.

```text
compiled target configuration
  -> dynamic subagent configuration, when present
  -> invocation-bound model override, when present
```

The override is separate from `DynamicSubagentAgentConfig`. Dynamic subagent configuration selects the target's complete runtime definition and controls its availability. Reusing that object for an invocation override would accidentally replace unrelated limits, reasoning, compaction, and description fields. A narrow runtime override composes after either the compiled or dynamic target configuration and changes only the model.

The child workflow persists the normalized reference in its context before session creation. Workflow replay therefore opens the same child model even if catalog metadata or the target's authored dynamic model changes later.

`agentWithModel` is a separate authored workflow tool; the default agent tool keeps its existing schema. Its model-visible schema is `{ message, model, taskId? }`, and its serve body opens the root-copy session through `ctx.agent("agent", { model })`. It shares the default agent tool's task lifecycle; a continuation must repeat the original model because the child session keeps that model for its lifetime.

## Validation

The owning tests should prove that effective runtime resolution replaces the model while retaining the target configuration, and that the public workflow context accepts a serializable model selection. Existing agent-session coverage owns lazy opening, local and remote target resolution, and child workflow startup; extend that boundary only for propagation and the remote rejection rather than duplicating its lifecycle matrix.
