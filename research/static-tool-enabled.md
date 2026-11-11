---
issue: TBD
status: proposed
last_updated: "2026-11-11"
---

# Offer a static tool on some calls

## Problem

A tool that only some model calls should offer, such as one for paid users, is a `defineDynamic()` tool that returns `null` when it shouldn't be offered. Workflow tools can't be: a `defineDynamic()` resolver may not return `defineWorkflowTool()`, because workflow tools are registered by name before any model call, for routing their durable runs. An agent whose gated action needs a workflow body, such as one that waits on `ctx.ask`, can only deny calls with `approval`. The model then sees a tool it may not use, calls it, and reads a denial.

## Authoring API

Static tools accept `enabled`, called with the `DynamicContext` a `defineDynamic()` function receives:

```ts
export default defineWorkflowTool({
  description: "Refund one of the user's orders.",
  enabled: (ctx) => ctx.session.auth.current?.attributes.plan === "pro",
  inputSchema: z.object({ orderId: z.string() }),
  async execute({ orderId }, ctx) {
    "use workflow";
    return await refundOrder(orderId);
  },
});
```

- eve evaluates `enabled` once before each model call, with the session's other dynamic values. The call, and everything that follows from it, reads that decision.
- While it returns `false`, the tool isn't in the model's tool list, and a call to it resolves to no tool. The tool stays registered: its name, workflow, and runs don't change.
- If it throws, the turn fails, as a throwing `defineDynamic()` function does.
- Omitted, the tool is offered on every call, as today.
- A dynamic tool entry with `enabled` fails evaluation: its `defineDynamic()` already decides whether to return it.

## Semantics

The agent's static tools keep one value in the session: the names of the gated tools the latest model call hid. Static tools without `enabled` keep nothing, so an agent that doesn't use it evaluates nothing new.

## Open questions

- A workflow call already waiting, such as on `ctx.ask`, resumes through its workflow run, not the tool list, so hiding its tool shouldn't stop it. This needs an integration test.
- `enabled` sits beside `availableInSubagents`, which also limits where a tool is offered, but statically.
