---
"eve": patch
---

Route all of eve's single-file bundles through a shared Rolldown helper that always disables code splitting. This closes a remaining gap where a dynamic import reachable from a final workflow bundle could still fail with "Expected one bundled ..." during builds.
