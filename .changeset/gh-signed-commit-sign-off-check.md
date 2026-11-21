---
"eve": patch
---

`gh-signed-commit` now reports a `Signed-off-by` trailer that does not match the author email GitHub recorded for the commit.

GitHub, not the message, picks that email, so a sign-off can name a different address and fail a DCO check. On a mismatch, the command still succeeds and writes the recorded email, the exact sign-off to use, and DCO remediation text to stderr. The `pr` skill tells the agent to follow that report instead of building the sign-off email itself.
