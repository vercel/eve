---
"eve": minor
---

Sessions now keep their streams and continuation addresses in a small holding workflow, with independent workflows executing each turn. Messages support `steer`, `queue`, and `interrupt`; workflow tools use promise-based `ask()` calls through one owner inbox.

This replaces the previous session runtime without migrating existing sessions and requires a Workflow SDK that provides `Run#getWritable()`.
