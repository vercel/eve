---
"eve": patch
---

Propagate dynamic skill resolver errors instead of continuing with stale skills. In an ordinary conversation turn, a turn-start resolver failure uses recoverable turn failure before the assistant model call. Session initialization and the separate authorization-callback preamble still propagate terminal failures.
