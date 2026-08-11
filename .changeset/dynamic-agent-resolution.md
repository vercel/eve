---
"eve": minor
---

Dynamic models and subagents now resolve without compiled fallbacks or placeholder configs. `defineDynamic` accepts only `events`; dynamic model handlers must return a concrete selection, while runtime model metadata is normalized and cached when the selection becomes active.
