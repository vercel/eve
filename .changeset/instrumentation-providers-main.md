---
"eve": minor
---

Make path-named files under `agent/instrumentation/` the supported instrumentation API. Existing `agent/instrumentation.ts` configurations must be split into lifecycle instrumentation, OpenTelemetry destinations, and shared `otel()` settings; extensions that contribute subagents must be rebuilt for the new contract epoch.
