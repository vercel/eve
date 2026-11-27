---
"@eve/self-improvement": patch
---

Buffer healthy tool observations until `turn.paused` or `turn.settled` and skip the pre-read before conditional Blob writes so telemetry no longer blocks every tool call.

Non-`"completed"` tool outcomes still write immediately in `"call.settled"` so failure signals are preserved; healthy `"completed"` tool calls buffered inside a step that is interrupted mid-step before saving state are best-effort.
