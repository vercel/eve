---
"eve": patch
---

Load `SKILL.md` files whose `metadata` holds nested or non-string values instead of failing the build. eve now ignores such `metadata`, like other frontmatter it does not use.
