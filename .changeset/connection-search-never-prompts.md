---
"eve": patch
---

A plain `connection_search` no longer asks the user to sign in: connections they have not authorized appear under `unavailable` with `requiresSignIn: true`, and the model signs in to one connection at a time with `connection_search({ connection, signIn: true })`. A completed sign-in now resumes the session right away, even while another sign-in prompt is still open, and a retried call reuses that open prompt instead of posting a new one.
