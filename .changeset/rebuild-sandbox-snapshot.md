---
"eve": minor
---

`rebuildSandboxTemplate()` from `eve/sandbox/vercel` and `repoSnapshotSchedule()` from `eve/extensions/git` refresh a Vercel sandbox's snapshot after a deploy.

New sessions open from the newest snapshot, so they start on a recent commit of a cloned repository without a redeploy. Each new session of a prepared Vercel sandbox makes one extra request to read it, 51 to 88 ms.

Every Vercel sandbox template is now keyed by its Vercel environment, so a preview build never seeds production's snapshot. The first deploy after upgrading rebuilds each template once.
