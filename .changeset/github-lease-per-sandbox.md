---
"eve": patch
---

GitHub commands now take turns per sandbox instead of per session.

Each command replaces the sandbox's whole network policy to lease its credential, so a subagent in its parent's sandbox could clear the parent's credential mid-request. GitHub then answered 401, and the caller was asked to sign in again even though their token was valid.
