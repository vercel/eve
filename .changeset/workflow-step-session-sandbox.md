---
"eve": patch
---

A `"use step"` helper in a workflow tool can now call `ctx.getSandbox()` to open the sandbox of the session that called the tool, on any sandbox provider, so a task can prepare files the session's later tool calls read. When the session had not recorded its sandbox when it called the tool, the step opens it with the owning session's sandbox definition; the step never owns the sandbox, and the session removes it when the session ends.
