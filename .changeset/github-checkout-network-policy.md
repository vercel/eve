---
"eve": patch
---

GitHub checkout now stays inside the sandbox network policy. It used to replace the policy with an open `"*"` rule plus the token, and never restore it, so a `deny-all` sandbox kept open egress for the rest of the session. The checkout now attaches the token only to `github.com` and `codeload.github.com`, fails with an error naming them when the policy does not allow them, and restores the policy when the fetch ends, including on failure. Header rules you set on those two hosts are replaced while the fetch runs. `setNetworkPolicy` now keeps any credentials eve has attached for an operation in progress.
