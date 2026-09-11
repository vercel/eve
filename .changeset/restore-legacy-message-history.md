---
"eve": patch
---

Resume sessions whose history predates user-message provenance instead of failing with a missing-kind error. Existing unclassified messages retain their content and are marked `legacy.unknown`, without treating unknown framework input as a new human request after compaction.
