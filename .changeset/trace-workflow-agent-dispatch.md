---
"eve": minor
---

Emit one bounded OpenTelemetry trace per agent activation, continuing only an awaited child's first activation from its caller and retaining `agent.*` lifecycle spans. Trace capture now preserves error privacy across worker replacement, bounds telemetry work, and keeps local delegation labels and usage totals consistent with the exported spans.
