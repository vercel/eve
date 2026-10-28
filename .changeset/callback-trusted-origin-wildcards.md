---
"eve": patch
---

`EVE_CALLBACK_TRUSTED_ORIGINS` now accepts a leading `*.` label, such as `https://*.preview.example.com`, so a remote agent can trust preview parents whose deployment URLs change on every deploy.

The wildcard matches exactly one subdomain label, and `*.vercel.app` and trailing dots are rejected.
