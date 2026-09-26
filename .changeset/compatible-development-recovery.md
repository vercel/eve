---
"eve": patch
---

At server startup, local development skips retained workflows whose framework build or authored workflow sources no longer match, or whose snapshot metadata is malformed, and reports why recovery was skipped. Those runs remain stored and dormant for that server invocation; hot reload preserves existing behavior for admitted runs, including follow-up turns, cancellation, and starting a new conversation.
