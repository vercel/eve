---
"eve": patch
---

Keep concurrent GitHub commands on one sandbox from removing each other's credential rules.

A turn and its subagents share one sandbox, and each `git__gh` command used to replace the whole network policy when it started and clear it when it finished, so one command's start or end could leave another running command with a 401. Each command now adds and removes only its own rule, reading the live rules back under a lock in the sandbox. `github` config gains a required `readRules(sandbox)` callback for that read, and Vercel sandboxes gain `getNetworkPolicy()`. Each rule is also scoped to the declared repository by request path, and GitHub commands stop after 30 minutes so a crashed command's rule expires.
