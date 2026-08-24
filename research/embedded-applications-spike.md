---
issue: "2221"
status: proposed
last_updated: "2026-08-18"
---

# Embedded application spike

## Decision

Test whether one application-owned agent definition can use eve's compiler,
Workflow runtime, and production builder without an `agent/` source tree.
Expose the proof through an experimental `eve/embedded` entrypoint with no
compatibility guarantee.

The spike supports one statically imported default export:

```ts
import { defineEmbeddedAgent } from "eve/embedded";

export default defineEmbeddedAgent({
  instructions: "Classify the support ticket.",
  model: "openai/gpt-5.4-mini",
  outputSchema: {
    properties: { category: { type: "string" } },
    required: ["category"],
    type: "object",
  },
});
```

A host can run the definition through a local Workflow World or send it through
the existing production builder. Compilation emits the normal manifest,
module map, metadata, Workflow bundle, and `/.well-known/workflow/v1/flow`
handler. JSON task input is encoded as a canonical user message, and task
completion requires exactly one structured `result.completed` event.

## Boundaries

- Only one embedded definition is supported. There is no registry or agent
  selection contract.
- Only one local executor can own the process-global Workflow World at a time.
- Human input is rejected. Authentication, idempotency, lookup, cancellation
  ownership, sandbox ownership, and revision pinning are not defined.
- The production builder proves artifact generation, not deployment or remote
  execution.
- Existing eve callback and infrastructure routes remain unchanged.

The fixture at `apps/fixtures/embedded-triage-cli` is the executable proof. A
follow-up decision must delete the spike, retain it as an internal example, or
replace it with a reviewed programmatic registry and headless execution design.
