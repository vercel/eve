---
"eve": patch
---

`gh-signed-commit` no longer reverts commits that are on the remote branch but missing from the local checkout.

It refuses when the branch has commits the checkout lacks and prints how to rebase onto them. It now publishes local commits along with staged changes, as one signed commit, and starts a new branch at the newest commit already on a remote instead of at the tip of the base branch. After committing, it moves the checkout to the commit it made rather than the branch tip, which another push may have moved. `--base` is still accepted but ignored, with a warning.
