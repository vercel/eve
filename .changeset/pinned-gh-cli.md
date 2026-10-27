---
"eve": patch
---

`installCodeTooling` installs `gh` 2.103.3 from GitHub's release, verified by checksum, so `gh pr update-branch` works and `gh pr edit` no longer fails with the Projects (classic) GraphQL error. Sandbox preparation now downloads from github.com, and `CODE_TOOLING_REVALIDATION_KEY` changes, so templates that include it rebuild.
