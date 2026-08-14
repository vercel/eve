---
"eve": patch
---

Allow a child to return `parent.sandbox` from a `defineSandbox` callback, reusing the dispatching parent's live sandbox across agent sessions. Parent and child see the same files, processes, workspace, and sandbox home. A child that selects `parent.sandbox` cannot also declare managed workspace or skill resources; eve rejects that configuration before execution and requires either removing those resources or giving the child its own sandbox.
