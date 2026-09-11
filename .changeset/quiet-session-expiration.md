---
"eve": patch
---

Session expiry now cancels the active turn and completes the session without delivering a synthetic result to a parent agent or invoking a session callback. Expired sessions no longer resume agent work when their children reach their own deadlines.
