---
"eve": patch
---

`localDev()` now recognizes a local development server by `NODE_ENV=development` (set by `eve dev`) or a `vercel dev` session instead of `EVE_DEV`. `eve start` and directly launched built servers default to `NODE_ENV=production`, so the synthetic local-dev principal is never granted on a production deployment. An explicit `NODE_ENV` in the environment is still respected.
