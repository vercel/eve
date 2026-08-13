---
"eve": patch
---

Make Nitro-backed builds more reliable by preserving per-import conditional exports, sharing one vendored OpenTelemetry API singleton, and running development worker close hooks during an explicit shutdown handshake. Workflow artifacts are now emitted directly instead of repaired through post-build string rewrites.
