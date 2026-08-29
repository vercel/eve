---
"eve": patch
---

Exposes `metricReaders` on `otelIntegration()` so destinations can declare OTLP metric readers alongside span processors. Readers from every destination are collected in declaration order and passed to `registerOTel`, which builds the process's meter provider. Also adds the metrics API surface to the vendored `@opentelemetry/api` declarations so user-land instrumentation code can typecheck against `metrics.getMeter()`.
