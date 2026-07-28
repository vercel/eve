---
"eve": patch
---

Declining a session token-limit prompt no longer leaves a stale copy of the prompt in the parked session. Previously the cancelled turn settled with a snapshot that resurrected the already-answered prompt, so every follow-up message was queued behind it and never re-raised the prompt; follow-ups now reach the budget gate, which re-raises a fresh prompt while the session is over budget.
