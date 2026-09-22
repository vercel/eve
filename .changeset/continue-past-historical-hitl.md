---
"eve": patch
---

Allow an active turn to finish its tool-result continuation when an earlier turn's HITL request remains unanswered, while preserving current-turn HITL parking. Partial approval responses remain saved until their batch can resolve; they do not cause an extra model call after an unrelated answer.
