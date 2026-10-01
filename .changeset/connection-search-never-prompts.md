---
"eve": patch
---

A plain `connection_search` no longer asks the user to sign in. A connection the user has not authorized now appears under `unavailable` with `requiresSignIn: true`, and tools from the other connections are still returned. The model asks for sign-in explicitly, one connection at a time, with `connection_search({ connection, signIn: true, query? })`, which returns that connection's tools once the user signs in. Broad searches no longer post a sign-in card for every connection the user has not authorized.

Completing a sign-in now resumes the session right away, even while another sign-in prompt is still open. Before, an ignored prompt, including one from an earlier turn, kept every later sign-in from resuming until the user sent another message.
