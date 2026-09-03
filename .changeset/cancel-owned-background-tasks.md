---
"eve": patch
---

Allow clients to cancel every background task owned by a session with `session.cancel({ tasks: true })`. Timed-out eval cases now reset their owned sessions before the next case starts so background work cannot leak across cases.
