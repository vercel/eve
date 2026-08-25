---
"eve": patch
---

Agent trace identity is now established before workflow execution begins, allowing workflow runs and OpenTelemetry spans to refer to the same trace from the outset. Delegated agents inherit the parent trace, while already-running sessions retain their current behavior. `TraceCaptureContext` gains an optional `channelType` carrying the channel's adapter kind (e.g. `"slack"`, `"http"`, `"schedule"`) so trace policies can sample by channel type.
