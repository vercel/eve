---
"eve": patch
---

Agents using AI Gateway web search no longer claim on the next turn that they answered before searching. When a reply continues after a search result in the same model call, eve now stores that text as its own assistant message, so AI Gateway replays it after the result instead of before the search.
