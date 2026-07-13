---
"eve": patch
---

perf: only scan the run store when pruning dev-runtime snapshots

`pruneDevelopmentRuntimeArtifactsSnapshots` walked the whole of `.workflow-data` and read every
file under 1MB to find snapshot references, so `eve dev` boot cost grew with everything the local
workflow world had ever written rather than with live work. Only runs carry a snapshot reference
(via `input.serializedContext["eve.bundle"]`), and runs are a small minority of the store — the
event, step, hook, stream, wait and lock directories were being read in full for nothing.

Those directories are now skipped. On a store shaped like a reported one (10,885 files: ~78%
events, ~13% steps, ~5% runs, ~4% hooks) the scan drops from 10,885 file reads to 500, and from
~253ms to ~12ms.
