---
"eve": patch
---

Judge `t.judge.autoevals.*` assertions no longer crash when the Braintrust reporter is active. The autoevals client bridge is now constructible so Braintrust's wrap-openai `isWrapped` probe can reconstruct it without losing `chat.completions.create`.
