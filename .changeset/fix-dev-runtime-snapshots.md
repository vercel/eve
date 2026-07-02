---
"eve": patch
---

Reduce development runtime snapshot disk usage by excluding `.env*`, generated dependency, and build output directories, using clone-friendly file copies where supported, and pruning stale snapshots after dev rebuilds.
