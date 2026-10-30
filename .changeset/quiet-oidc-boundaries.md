---
"eve": patch
---

Bound OIDC metadata requests and require Vercel tokens to carry their owner's exact audience.

Vercel verification now shares a fixed discovery endpoint across team and global issuers. Metadata requests have time and size limits, reject redirects, and briefly back off after failures.
