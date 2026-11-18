---
"@vercel/agent-runs": minor
---

`otelTelemetry()` writes spans under the `vercel.ai.tracing` instrumentation scope by default, which Vercel Agent Runs reads; pass `tracerName` to use another scope.
