---
"eve": patch
---

MCP connections close their remote session when the step that opened it ends, instead of leaking one session per step until the process exits. A step that ends while its connection is still connecting, or a sign-in that finishes after its step, can still leave one session open. HTTP MCP connections keep at most one inbound SSE stream per session: the stream opens only after the session exists, and reconnecting never opens a second one while a stream is attached, so servers that allow a single stream no longer answer `409`. Ending a session is bounded best effort: its `DELETE` gives up after 5 seconds, so a server that stops answering doesn't stall the step.
