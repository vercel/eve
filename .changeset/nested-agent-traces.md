---
"eve": patch
---

The first local or remote subagent turn now uses the caller's OpenTelemetry trace as a child of its dispatch span. Later child turns start new traces, and third-party spans created during model, tool, and memory execution receive the conversation ID.
