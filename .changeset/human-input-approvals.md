---
"eve": patch
---

Tool approvals hold the turn again, and eve runs the approved calls itself with the tools of the step that asked, re-checking each approval first. History no longer contains the AI SDK's approval parts: a waiting call stays in history without a result until its approval resolves. A typed reply answers the open approvals it matches, and the rest keep waiting. Approvals whose tool defines an `approval.response` policy still fail with `HUMAN_INPUT_UNAVAILABLE`.
