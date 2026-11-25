---
"eve": patch
---

On an OpenAI model, `defaultCompaction()` now appends its summary after the messages it keeps and leaves those messages unedited, so OpenAI keeps their reasoning.

It no longer caps kept tool results or rewrites kept assistant messages as text on that model. A compaction strategy's checkpoint can now sit anywhere in the history, and eve checks only that there is at most one.
