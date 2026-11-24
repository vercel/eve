---
"eve": minor
---

`rebuildable: true` in the Vercel sandbox options lets `rebuildSandboxTemplate()` and `repoSnapshotSchedule()` refresh the template after a deploy.

Every Vercel sandbox template is now keyed by its Vercel environment, so a preview build never seeds production's snapshot. The first deploy after upgrading rebuilds each template once.
