---
"eve": minor
---

`rebuildable: true` in the Vercel sandbox options lets `rebuildSandboxTemplate()` and `repoSnapshotSchedule()` refresh the template after a deploy, and scopes that template to its Vercel environment so previews never replace production's.
