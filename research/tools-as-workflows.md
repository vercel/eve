---
issue: https://github.com/vercel/eve/issues/1084
status: implemented
last_updated: "2026-09-04"
---

# Tools as workflows

`defineWorkflowTool` is the authoring boundary for durable tools, and its executor context owns
`agent` and `ask`. The executor must explicitly start with `"use workflow"`; the definition
selects the eve tool contract and the directive marks the function's replay semantics.

## Model-authored orchestration

The framework `code_mode` tool replaces the former `Workflow` wrapper. Enable it
with `experimental.codeMode: { mode: "eager" | "lazy", maxSubagents?: number }`.
Each program pins its catalog and subagent-call budget. The default budget is
100 invocations, including retries and continuations. Authored workflow tools
remain independent of this model-facing wrapper.

## Authoring API

```ts
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Review and deploy a service after approval.",
  inputSchema: z.object({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";
    const review = await ctx.agent({
      key: "review",
      target: "reviewer",
      message: `Review ${service} for deployment.`,
    });
    const answer = await ctx.ask({
      prompt: `Deploy ${service}?\n${JSON.stringify(review)}`,
      display: "confirmation",
      options: [
        { id: "approve", label: "Deploy", style: "primary" },
        { id: "cancel", label: "Cancel" },
      ],
    });
    if (answer.optionId !== "approve") return { deployed: false };
    return { deployed: true, service };
  },
});
```

The executor receives `WorkflowToolContext`: `session`, `callId`, `toolName`, `abortSignal`,
`agent(input)`, and `ask(request)`. Ordinary `ToolContext`, channel contexts, and schedule contexts
have no `agent` or `ask` methods. Shared helpers can accept `WorkflowToolContext` explicitly.
The turn-owned `getSandbox`, `getSkill`, `getToken`, and `requireAuth` methods are absent from this
public type. Side effects and credential reads belong in top-level `"use step"` helpers.

Export `defineWorkflowTool({ ... })` directly as the default export of a static tool module.
`execute` is an inline async function or async generator, or a reference to a top-level async
function in the same module or an imported application module. With `execution: "background"`, the third executor argument is `task`; its `postMessage` method
creates a yielded message descriptor. Schemas, approvals, and model-output projections have
the same meaning as for the existing workflow tool runtime.

## Compilation boundary

The source pass validates directive placement and hoists inline executors into the shape consumed
by the Workflow transform. Definition validation checks the compiled executor's `.workflowId`,
so missing directives fail during compilation without recognizing the definer's import spelling.
Discovery filters candidate files by directive text, then uses the same AST validation as the
transform; directives can be the first statement on the function's opening line. Workflow IDs
derive from the declaring module's application-relative path and function name, so migrating the
wrapper does not rename an existing inline executor.

The definition carries a workflow-tool brand. Compilation requires both that brand and a compiled
executor workflow ID. An ordinary `defineTool` or bare object with a workflow executor fails the
build; an uncompiled `defineWorkflowTool` also fails instead of running inline. Channel and
schedule handlers cannot be workflow executors. Dynamic resolvers cannot return workflow tools.
Standalone Workflow SDK functions used by workflow helpers retain their SDK semantics.

The driver drops the definition and schema imports, then runs the registered executor with a
context reconstructed for that run. `ctx.agent` and `ctx.ask` bind the existing invocation and
input-request operations to that context. No callable helpers are serialized across the run
boundary. This replaces call-site analysis with an explicit definition boundary and context types.

## Observable semantics

Each tool call starts one durable run. By default the turn parks and the eventual return value,
error, or cancellation resolves the model's tool call. With `execution: "background"`, the model
receives a task receipt. Ordinary yields are stream-only progress; yielding
`task.postMessage(message)` wakes the owning agent, as does completion.

`ctx.agent` delegates to a visible subagent. Its required `key` is unique within the run and keeps
invocation identity stable across replay. `ctx.ask` publishes an input request on the session's
channel and returns an awaitable answer. It can be raced against `sleep`; finishing or cancelling
the run withdraws pending requests. The existing owner hooks and message protocol stay internal.

An async generator's `yield` reports progress. `ctx.abortSignal` remains durable and supports
cleanup in steps after cancellation. Steps, retries, replay, and Workflow SDK primitives keep
their existing behavior.

## Migration

- Replace `defineTool` with `defineWorkflowTool` for workflow tools and keep the executor's
  `"use workflow"` directive.
- Replace `agent(ctx, input)` with `ctx.agent(input)` and `ask(ctx, request)` with `ctx.ask(request)`.
- Remove imports from `eve/workflow`; that entry point is removed. Import `WorkflowToolContext`,
  `AgentInput`, `ToolInputRequest`, and `ToolInputResponse` from `eve/tools` when needed.

This is a breaking public API change. The existing workflow-tool fixture migrates to the new API
and continues to cover delegation, human answers, deadlines, progress, background execution, and
cancellation. Compiler tests cover the new entry point and rejection of the old authoring shapes.
