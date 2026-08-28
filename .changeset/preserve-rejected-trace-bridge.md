---
"eve": patch
---

Make instrumentation-provider content capture independent from OpenTelemetry `tracePolicy`. Rejected eve traces retain metadata-only AI spans in the ambient Workflow trace, while each provider receives only the metadata or content it requested.
