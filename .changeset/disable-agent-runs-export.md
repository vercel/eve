---
"eve": minor
---

eve no longer exports traces to Vercel Agent Runs in preview or production deployments. The `agentRuns()` instrumentation destination has been removed; use `otelIntegration()` to configure another exporter or `localTraces()` during development.
