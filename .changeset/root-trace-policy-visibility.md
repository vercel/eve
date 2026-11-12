---
"eve": patch
---

A root session whose `otel({ tracePolicy })` explicitly records inputs and outputs for its audience now tags its workflow run as content-visible, so Agent Runs shows the content its spans already record instead of a private run.

The run's visibility follows the session's own trace decision the way instrumentation applies it: an explicit decision counts only for the audience the policy evaluated, and a session whose policy drops the trace stays hidden. Sessions without OpenTelemetry keep the audience default.

Thanks @zackleman for reporting this in #5931.
