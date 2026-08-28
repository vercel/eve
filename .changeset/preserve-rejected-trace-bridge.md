---
"eve": patch
---

Instrumentation-provider content delivery now depends only on each provider's `capture` declaration: providers that declare `capture: "content"` receive full event content regardless of channel audience or OpenTelemetry `tracePolicy`. Separately, a `tracePolicy` that drops the eve trace no longer disables AI SDK telemetry: metadata-only AI spans (model, tokens, and timing, without message content) are still emitted into the ambient Workflow trace, and `agent.session` is not emitted.
