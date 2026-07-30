---
"eve": patch
---

`eve eval` gains a repeatable `--exclude-tag <tag...>` flag that skips evals carrying a tag. Exclusion applies after `--tag` inclusion, and a run where exclusion removes every matching eval now exits successfully with nothing executed. `--list` reports the post-filter selection — `--list --json` prints `[]` when exclusion removes everything — so suite runners can probe whether anything would run.
