---
"eve": minor
---

New Vercel sandbox sessions now start from the newest snapshot of the template instead of the one captured at deploy, and `rebuildSandboxTemplate()` from `eve/sandbox/vercel` captures a newer one without a redeploy. `eve/extensions/git` adds `repoSnapshotSchedule()` and `refreshRepoSnapshot()`, which rebuild the snapshot when a branch moves so a large repository checkout stays current.
