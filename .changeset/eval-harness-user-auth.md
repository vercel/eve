---
"eve": patch
---

`eve eval` sessions now authenticate as a synthetic eval user (`principalType: "user"`) on the local dev server the runner boots, so user-scoped flows — interactive connection authorization and sandbox egress consent — park and resume inside evals instead of failing on the synthetic local-dev principal. The runner mints a per-run secret that never leaves the process; ordinary deployments and `eve dev` servers are unaffected.
