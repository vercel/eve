---
"eve": patch
---

Evals can replace what tools return with stub sets in `evals/stubs/`, selected with `t.send(message, { stubs })` or `t.session({ stubs })`. Approvals and result handling stay real, and only the local server `eve eval` starts accepts stubs.
