---
"eve": patch
---

Expose thread-scoped cancellation in Slack message and interaction contexts, plus target-addressed cancellation in `onEvent`, so authored Slack handlers can stop or replace in-flight turns.
