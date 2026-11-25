---
"@eve/board": patch
---

Fix `watch` and `unwatch` failing with `client_id_taken` after an `@eve/board` mount's `watchChannel` changes, by reusing the agent's existing watch lock wherever it lives.
