---
"eve": patch
---

Fix nested connector actions appearing as unrelated model tool calls in traces: they now carry their parent call ID and nest beneath the calling action. Action spans also retain their request start time and cover tool execution when SDK telemetry arrives first.
