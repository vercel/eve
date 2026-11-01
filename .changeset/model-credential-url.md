---
"eve": patch
---

`eve dev` can take its AI Gateway credential from the program that starts it: set `EVE_MODEL_CREDENTIAL_URL` and `EVE_MODEL_CREDENTIAL_TOKEN`, and every Gateway model call, including compaction, uses the credential that URL serves, ahead of every other connection. When Gateway refuses the token, eve asks the URL for a fresh one.
