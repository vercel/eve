---
"eve": patch
---

Fixed models claiming an approved tool call had not run. eve wrote a `[Pending approvals]` note into session history when a call awaited approval and never removed it; pending approvals now reach the model only through the notice rebuilt for each model call, which drops them once they're answered.
