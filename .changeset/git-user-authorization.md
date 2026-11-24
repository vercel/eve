---
"eve": minor
---

`eve/extensions/git` takes an `authorization` for `principalType: "user"`, in the shape a connection's `auth` takes, so a caller's GitHub token can come from your own service instead of a Vercel Connect connector. Set exactly one of `connector` and `authorization`; `connector` behaves as before.
