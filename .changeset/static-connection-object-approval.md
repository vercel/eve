---
"eve": patch
---

A connection in `agent/connections/*.ts` now keeps an `approval` written as `{ request, response, prompt }`, so its tools ask for approval and run its `response` policy.

Previously only the function form was kept and the object form was dropped, so the connection's tools ran without asking anyone. A malformed `approval` now fails resolution instead of being ignored.
