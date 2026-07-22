---
"eve": patch
---

Declining a session token-budget prompt now cancels the in-flight turn cleanly (`turn.cancelled` → `session.waiting`) instead of completing the session or surfacing an error to the delegating parent. Declining a delegated child's prompt cancels the whole turn tree from the root, so the parent can no longer retry the child against a fresh quota share, and stale answers to budget prompts are dropped instead of being shown to the model. The prompt copy is reworded ("This session has hit the input-token limit (2M) per session…") with Approve/Stop buttons.
