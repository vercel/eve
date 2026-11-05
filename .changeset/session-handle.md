---
"eve": patch
---

`createSession` in `eve/experimental/embed` and `eve/browser` returns a `SessionHandle`, the handle `eve/client`'s `ClientSession` implements (`send`, `respond`, `cancel`, `clear`, `compact`, `end` and `stream`).

It's async, and its session has an id from the start. The restorable `snapshot()` is now `checkpoint()`, and `events()` is now `stream()`.
