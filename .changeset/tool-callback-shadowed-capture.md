---
"eve": patch
---

Fix `eve build` failing with "Identifier has already been declared" when a tool callback's destructured parameter or local declaration shadows a variable from an enclosing scope. This also fixes building agents that mount `eve/extensions/git`.
