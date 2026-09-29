---
"eve": patch
---

Traces no longer give each `ctx.agent()` call in a workflow tool its own `agent.action` caller span, and a workflow tool that calls agents stays an `agent.action` span instead of becoming `invoke_workflow <tool>` with `gen_ai.workflow.name`. Sessions opened with `ctx.agent()` now link to the calling tool's `agent.action` span, and their usage no longer appears on a separate caller span; it still counts toward the parent session's usage.
