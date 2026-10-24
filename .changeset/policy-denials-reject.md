---
"eve": patch
---

A call its approval policy denies now settles `rejected` with `cause: { policy: "approval" }`, as denials on recheck and in `invokeTool` already did, instead of `failed`. A refused call is no longer confused with a tool that ran and threw. The model still reads the same denial.
