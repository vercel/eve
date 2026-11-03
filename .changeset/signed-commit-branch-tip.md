---
"eve": patch
---

`gh-signed-commit` no longer reverts commits that are on the remote branch but missing from the local checkout.

It now refuses to commit when local HEAD is not the tip of an existing branch, and asks the agent to run `git pull --ff-only origin <branch>` and retry. New branches start at local HEAD, as with `git push`, instead of at the tip of the base branch. `--base` is still accepted but no longer chooses where a new branch starts.
