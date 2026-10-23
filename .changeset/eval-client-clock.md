---
"eve": patch
---

Eval artifacts now record client timing for each captured session: when each request was sent and accepted (including time spent retrying `session_not_ready`) and when each event arrived. `eve eval --keep-state` keeps the local eval server's state, including its Workflow data, after the run.
