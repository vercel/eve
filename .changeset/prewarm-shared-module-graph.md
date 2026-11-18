---
"eve": patch
---

`eve build` no longer evaluates every authored module a second time to prepare sandbox templates.

Sandbox prewarm now reuses the modules that compilation already evaluated from one shared bundle, so build memory and time stay flat as an agent gains tools and subagents instead of growing with each module that imports shared code. Sandbox template keys are unchanged, so existing templates are reused.
