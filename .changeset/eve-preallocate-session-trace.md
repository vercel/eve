---
"eve": patch
---

Preallocates the session trace id before workflow startup so `$eve.trace_id` can be tagged at run creation time and `agent.session` later reuses the same trace id. The trace policy is evaluated before `start()`, a serializable trace seed persists in the workflow input, and `AgentSpanIdGenerator.withTraceId` primes the session span. Delegated agents inherit the parent trace context; seedless workflow inputs retain current behavior as a narrow fallback. `TraceCaptureContext` no longer includes `rootSessionId` or `sessionId` — the policy is now evaluated before the workflow run id exists.
