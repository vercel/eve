---
"eve": patch
---

AI SDK telemetry integrations such as Sentry's now receive model prompts and responses whenever the `otel()` trace policy or any instrumentation file's `tracePolicy` allows content, without an `otelIntegration()` destination.

Starting with `ai@7.0.163`, the AI SDK removes content from telemetry when a call disables `recordInputs` or `recordOutputs`. Before this release, eve disabled both on every model call in apps without an OpenTelemetry destination, so a Sentry-only setup lost prompts, responses, and token usage. Apps that added an empty `otelIntegration({})` only to work around this can remove it.
