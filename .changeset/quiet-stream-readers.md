---
"eve": patch
---

Fix client `result()` calls hanging after a turn finishes when fetch instrumentation clones the event stream, including eve-to-eve calls from authored tools. Client and TUI subagent stream cleanup now releases the HTTP connection without waiting for the tracing reader.
