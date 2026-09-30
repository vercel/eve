---
"eve": patch
---

When approvals for two pending batches from different turns arrive in one delivery and a response policy allows both, both approved calls now run in that turn. Before, only the first call ran and the turn ended with the second batch still pending until another message woke the session.
