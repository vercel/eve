---
"eve": patch
---

AI SDK telemetry integrations such as Sentry's now receive model and `decide()` prompts and responses whenever the `otel()` trace policy or any instrumentation file's `tracePolicy` allows content, without an `otelIntegration()` destination.

Starting with `ai@7.0.163`, the AI SDK removes content from telemetry when a call disables `recordInputs` or `recordOutputs`. Before this release, eve disabled both on every model call in apps without an OpenTelemetry destination, so a Sentry-only setup lost prompts, responses, and token usage. Apps that added an empty `otelIntegration({})` only to work around this can remove it.

In apps without OpenTelemetry, `decide()` calls previously left these settings unset, so AI SDK integrations received decision content for every conversation. They now follow the same rules as model calls: content for public conversations and in development by default, and otherwise only when a trace policy allows it.
