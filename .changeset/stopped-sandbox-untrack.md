---
"eve": patch
---

A sandbox that was stopped and then ended no longer stays registered for server shutdown, so long-running eve servers stop accumulating ended sessions and shutdown no longer stops their connections again.
