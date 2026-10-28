---
"eve": minor
---

`git({ github: { tokenParams } })` lets agents choose the Connect token params for each `gh` command. The callback receives the caller, the declared repository, and eve's default app-subject params, and can return a user subject so commands run with the caller's own GitHub permissions.
