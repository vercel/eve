---
"eve": patch
---

Scope the GitHub checkout's installation-token network policy broker to the fetch window instead of leaving it applied for the rest of the session. `checkoutGitHubRepository` now reads the sandbox's prior network policy before brokering the token at the firewall and restores it in a `finally`, so the broker's wide-open `"*"` rule no longer widens egress an author had locked down, and a failed fetch can't strand the sandbox in the widened state. `SandboxSession` gains `getNetworkPolicy()` to support this, backed by a `SandboxNetworkPolicyRef` that `buildSandboxSession` keeps in sync with every accepted `setNetworkPolicy` call.
