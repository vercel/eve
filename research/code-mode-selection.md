---
issue: https://github.com/vercel/eve/pull/3002
status: implemented
last_updated: "2026-09-08"
---

# Code Mode tool exposure

Code Mode preserves direct access to built-in tools, authored tools, and subagents; eligible dynamic tools use on-demand discovery.

Enable it with `experimental.codeMode: true`. The removed
`mode` selector is not needed: schema discovery and execution eligibility are
separate decisions. Dynamic provenance comes from the dynamic tool provider,
not tool names. Approval-gated tools and framework controls stay direct-only.

Use direct calls for simple operations; use programs for substantial fan-out,
loops, and reducing intermediate results. Inside a program, subagent calls await
the final response. Direct subagent calls retain their background task receipts.

Each nested tool returns context and sandbox changes separately from its output.
Later calls consume those changes. The completed, failed, or cancelled program
reports its accumulated changes to the owning turn, which merges only changed
fields. Independent parallel updates merge; conflicting writes fail explicitly.
Already-completed external side effects are not rolled back. Individual tool
steps retain their durable replay boundaries.

Unit tests cover fresh-context file and todo operations, parallel state updates,
parent settlement, and visibility. The deterministic E2E fixture covers nested
state followed by a direct call in the next parent turn; it runs in CI only.
These routing and persistence changes have not received a new benchmark run.
