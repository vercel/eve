---
"eve": minor
---

`eve/extensions/git` takes a user-scoped `authorization` in the shape a connection's `auth` takes, so a caller's GitHub token can come from your own service instead of a Vercel Connect connector.

Set exactly one of `connector` and `authorization`, and give the `authorization` `principalType: "user"`; `connector` behaves as before.
