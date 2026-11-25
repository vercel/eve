---
"@eve/board": patch
---

Fix `watch` and `unwatch` failing with `client_id_taken` after an `@eve/board` mount's `watchChannel` changes, by giving each watch channel its own lock task.
