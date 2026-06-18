---
"eve": patch
---

Fix `eve dev` failing with `LoadCompiledModuleMapError` when resolving an agent's model for an app that has a `run`-handler schedule (or any module-map entry) which statically imports an authored channel. Runtime model resolution now loads the dev module map through the authored-source hydrator, matching the rest of the dev runtime, so authored `.js` import specifiers resolve to their `.ts` sources. Production builds are unaffected.
