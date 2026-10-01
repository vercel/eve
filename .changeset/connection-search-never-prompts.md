---
"eve": patch
---

A plain `connection_search` no longer asks the user to sign in: connections they have not authorized appear under `unavailable` with `requiresSignIn: true`, and the model signs in to one connection at a time with `connection_search({ connection, signIn: true })`. A turn waiting on several sign-ins resumes once all of them are done.
