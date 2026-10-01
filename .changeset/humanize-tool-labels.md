---
"eve": patch
---

Tool, agent, and connection names now read as plain words in activity labels, approval prompts, and the Slack status and task card. An extension or memory namespace before `__` is dropped, and `sync_accounts` or `syncAccounts` shows as `Sync accounts`. A connection call shows as `Linear: List issues`, and its approval asks `Approve Linear: List issues?` instead of naming `connection_execute`. Agent calls read as `Researcher: Find the March incidents`. Labels set with `label.start` are unchanged.
