---
"eve": patch
---

A model response that mixes AI Gateway `web_search` results with local tool calls such as `web_fetch` no longer breaks the next model call. eve kept a local call ahead of a later search result, so Anthropic rejected the history with "`tool_use` ids were found without `tool_result` blocks" and the turn failed.
