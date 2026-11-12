---
"eve": patch
---

Add `github.access` to the git extension so an agent can write to public repositories only, or to private and internal repositories only.

`"private-write"` makes public repositories read-only and private and internal ones read-write. `"public-write"` makes public repositories read-write and refuses private and internal ones. GitHub enforces it: `"app"` tokens are minted read-only for public repositories, and `"user"` commands are refused while the caller's App installation reaches repositories or holds permissions the setting rules out. `"private-write"` refuses write permissions outside `actions`, `checks`, `contents`, `issues`, `pull_requests`, `statuses` and `workflows`.
