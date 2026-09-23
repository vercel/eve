---
"eve": minor
---

Breaking: `ctx.getSkill()` and the `SkillHandle` and `SkillFile` types from `eve/skills` are removed. The model still reads skill supporting files with its sandbox tools; if your own tool or hook code needs that data, import it from a module in `lib/` instead. Existing extension builds keep loading unless they call `ctx.getSkill()`.
