---
"eve": patch
---

`gh-signed-commit` in `eve/extensions/code` now commits staged files larger than 1 MiB, such as monorepo lockfiles, instead of failing with `spawnSync git ENOBUFS`.
