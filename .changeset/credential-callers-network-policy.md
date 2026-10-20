---
"eve": patch
---

Self-modification checkouts and eve-code firewall credentials now stay inside the sandbox network policy. Self-modification used to reset the policy to `allow-all` after brokering its GitHub token, and eve-code's `authenticateGitHub`/`authenticateVercel` replaced it with an open `"*"` rule. Both now attach their credentials only to hosts the policy already allows, and fail with an error naming the hosts when it does not, for example under `deny-all`. A custom `broker` callback is unchanged.
