---
"eve": patch
---

Bound the zero-config local trace store so `.eve/traces` no longer grows without limit. `eve dev` now sweeps it when a session finishes and at startup, keeping open sessions, the twenty newest traces, and anything from the last seven days before evicting oldest-first above 512 MB. Tune it with `EVE_TRACES_MAX_AGE_MS`, `EVE_TRACES_MAX_TOTAL_BYTES`, and `EVE_TRACES_RETAIN_COUNT`, or set `EVE_TRACES=off` to turn local tracing off entirely.
