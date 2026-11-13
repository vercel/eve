---
"eve": minor
---

`defineWorkflowTool` tools with an `execute` entry point now accept `endsTurn`, so a workflow that waits for the user can end the turn without a model reply.

Pass `true`, or a function that receives the call's output. `task` and `serve` entry points still reject it.

Thanks @matchai for requesting this.
