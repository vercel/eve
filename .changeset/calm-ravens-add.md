---
"eve": patch
---

Registry items can now declare optional pnpm packages with build scripts. Before installation, eve asks whether to skip those packages, allow their scripts, or abort, and records the choice in the owning workspace policy.
