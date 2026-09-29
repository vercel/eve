---
"eve": patch
---

The default message reducer gives assistant text and reasoning parts a stable `id` across streaming, completion, and replay, and keeps late-arriving participant messages ahead of their turn's response. Authorization parts match completions by `attemptId` and mark callback-backed sign-ins with `awaitsCallback`; replayed tool events no longer reopen a settled approval, and rejected tool results render as denied.
