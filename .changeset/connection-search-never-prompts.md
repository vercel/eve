---
"eve": patch
---

`connection_search` no longer asks the user to sign in. A connection that needs the user's authorization before its tools can be listed now appears under `unavailable`, and tools from the other connections are still returned. Sign-in is requested only when the model calls `connection_execute` on that connection, so broad searches no longer post a sign-in card for every connection the user has not authorized.

Completing a sign-in now resumes the session right away, even while another sign-in prompt is still open. Before, an ignored prompt, including one from an earlier turn, kept every later sign-in from resuming until the user sent another message.
