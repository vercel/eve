---
"eve": patch
---

Self-modification now rejects target branch names Git rejects: path components starting with `.` (such as `.hidden` or `feature/.hidden`) and names containing the DEL character.
