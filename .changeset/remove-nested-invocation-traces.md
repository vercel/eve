---
"eve": patch
---

Traces no longer give each `ctx.agent()` call in a workflow tool its own `agent.action` caller span, and a workflow tool that calls agents stays an `agent.action` span instead of becoming `invoke_workflow <tool>` with `gen_ai.workflow.name`. Sessions opened with `ctx.agent()` now link to the calling tool's `agent.action` span, and their usage counts toward the parent session's usage instead of appearing on a caller span.
