---
"eve": patch
---

Dynamic skill resolvers that return a map now name every entry `<slug>__<key>` even when the map holds a single entry, matching dynamic tools and the documented contract. Previously a one-entry map was advertised and materialized under the bare resolver slug, so `load_skill` failed to find it and adding a second skill silently renamed the first. `load_skill` failures now also list the available skill names so the model can correct a wrong id.

Adds a `t.loadedSkill(skill, opts?)` eval assertion — sugar for `t.calledTool("load_skill", { input: { skill }, ... })`.
