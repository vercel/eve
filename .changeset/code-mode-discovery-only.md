---
"eve": minor
---

Code Mode now exposes eligible tools exclusively through programs with on-demand schema discovery. Remove `mode` from `experimental.codeMode`; use `{}` or `{ maxSubagents: 25 }`. Approval-gated tools and framework controls remain directly callable.
