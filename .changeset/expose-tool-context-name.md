---
"eve": patch
---

`ToolContext` now exposes `toolName`, the final runtime tool name, so executors can share routing, authorization, and observability logic without duplicating path-derived or qualified names.
