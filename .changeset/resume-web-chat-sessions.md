---
"eve": patch
---

Add declarative `resume: true` and imperative `resume()` support for replaying durable frontend sessions and following in-flight turns. Generated Web Chat apps now keep session IDs in `/s/{sessionId}` URLs, restore conversations on reload, and provide a sessionless `/s` route for starting a new chat.
