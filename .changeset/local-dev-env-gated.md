---
"eve": minor
---

`localDev()` now grants the synthetic local principal based on the deployment (an `eve dev` or `vercel dev` process) instead of the request URL host, so a request `Host` header can no longer obtain local-dev access on a self-hosted server. The previously exported `isLoopbackRequest` helper is removed. The default eve channel now falls back to `[vercelOidc(), localDev(), placeholderAuth()]`, which keeps local dev working and rejects all production traffic.
