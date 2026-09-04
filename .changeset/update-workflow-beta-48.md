---
"eve": patch
---

Update eve's bundled Workflow SDK packages to the latest 5.0.0 beta releases (`@workflow/core` 5.0.0-beta.48). Sessions now claim their inbox hook in-process instead of taking an extra queue hop at start, so a new session reaches its first turn one delivery sooner.
