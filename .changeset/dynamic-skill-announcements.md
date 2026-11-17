---
"eve": patch
---

Dynamic skill announcements now send only the current dynamic skills when the system prompt already has the skill rules, name withdrawn skills, and are wrapped in `<skills_update>` so the model can tell eve wrote them.

Thanks @atacan for reporting this in #6483.
