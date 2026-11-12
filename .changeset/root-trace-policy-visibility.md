---
"eve": patch
---

A root session whose `otel({ tracePolicy })` withholds inputs or outputs, or drops the trace, no longer tags its workflow run as content-visible, so observability stops showing run data the policy excludes.

A trace policy can only hide content its audience would show by default. A private or unknown-audience run stays hidden even when its policy records content, because Agent Runs' `exportPolicy` may still redact those spans. Sessions without OpenTelemetry keep the audience default.

Thanks @zackleman for reporting the related visibility gap in #5931.
