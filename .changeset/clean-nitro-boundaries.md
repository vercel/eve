---
"eve": patch
---

Make Nitro-backed builds more reliable by preserving per-import conditional exports, keeping authored and vendored OpenTelemetry tracers on one registered provider, and running development worker close hooks during an explicit shutdown handshake. Workflow artifacts are now emitted directly instead of repaired through post-build string rewrites.
