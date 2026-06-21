---
"eve": minor
---

Dynamic map resolvers no longer auto-prefix entries with the file slug — the map key is the tool/skill name verbatim (a single `defineTool`/`defineSkill` is still named after the file slug). Namespace keys yourself (e.g. `team__playbook`) when a bare name might collide. A dynamic tool/skill overrides a same-named authored one; two dynamic resolvers emitting the same name now throw, recommending manual namespacing. Connection tools are renamed accordingly: the search tool is `connection_search` and discovered tools are `<connection>__<tool>` (e.g. `linear__list_issues`).
