---
"eve": patch
---

`installCodeTooling` installs `gh` 2.103.3 from GitHub's release, verified by checksum, so `gh pr update-branch` works and `gh pr edit` no longer fails with the Projects (classic) GraphQL error. Preparation needs `curl` and access to github.com and release-assets.githubusercontent.com. A prepared environment keeps its old `gh` until its sandbox file or environment options change.
