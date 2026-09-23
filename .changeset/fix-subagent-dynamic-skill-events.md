---
"eve": patch
---

Fix subagent delegation failing with `Context key "eve.sandbox" is not set` when the parent has dynamic skills. Skill announcements are rebuilt at model preparation boundaries, so subagent notifications no longer require sandbox access.
