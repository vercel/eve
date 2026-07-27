---
"eve": patch
---

Fixed non-fatal "Operation attempted on ended Span" errors on long-running self-hosted deployments. Error logs emitted after a turn's OpenTelemetry span ended are now dropped instead of writing to the ended span.
