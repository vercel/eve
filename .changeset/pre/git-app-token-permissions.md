---
"eve": patch
---

Add `github.permissions` to the git extension's `"app"` config. eve mints each installation token with only those permissions, so a broker no longer has to re-mint a narrower token and rebuild the credential header for every GitHub host eve leases.
