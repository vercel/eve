---
"eve": minor
---

Skills now load through `eve__execute({ skill })`, and a skill with `deferred: true` (in `SKILL.md` frontmatter or on `defineSkill`, static or dynamic) leaves the system prompt and is found with `eve__search` instead.

- The `load_skill` tool and the `eve/tools/load_skill` export are removed. Delete any `agent/tools/load_skill.ts` override or approval policy that names it; an authored `agent/tools/load_skill.ts` is now an ordinary tool.
- A skill load now reports a `load-skill-result` named for its skill instead of a `tool-result` named `load_skill`, and its client message part is named for the skill.
- Eval facts report skill loads in `skillLoads`, which `t.loadedSkill` reads. They no longer count toward `toolCallCount`, `usedNoTools`, or `maxToolCalls`.
- Skill names must use only ASCII letters, digits, underscores, and dashes, start with a letter or digit, and have at most 64 characters. The compiler rejects a static skill with another name, and eve skips a dynamic skill resolver that returns one.
