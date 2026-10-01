---
"eve": patch
---

Slack `onMessage` now receives only newly posted messages. Edits, deletions, and other system message events go to `onEvent`, so updating the agent's own HITL card in a DM no longer starts a stray session.
