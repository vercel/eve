---
"eve": patch
---

Tool approvals now resolve before channel context is added to the next model request, so approving a tool from channels such as Linear executes the tool instead of leaving a dangling tool call.
