---
"eve": patch
---

`gh-signed-commit` no longer reverts commits that are on the remote branch but missing from the local checkout.

It now refuses to commit when local HEAD is not the tip of an existing branch, and prints the commands that bring the checkout up to date. After committing, it moves the checkout to the commit it made rather than the branch tip, which another push may have moved. New branches start at local HEAD, as with `git push`, instead of at the tip of the base branch. `--base` is still accepted but ignored, with a warning.
