---
"eve": patch
---

Add `github.access` to the git extension. `"private-write"` makes public repositories read-only and private and internal ones read-write. `"public-write"` makes public repositories read-write and refuses private and internal ones. GitHub enforces it: `"app"` tokens are minted read-only for public repositories, and `"user"` commands are refused while the caller's App installation reaches repositories the setting rules out.
