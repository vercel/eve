---
"eve": patch
---

Anthropic model calls whose history ends on an assistant message, for example after answering an approval, now send a transient `Continue.` user message, so Anthropic no longer rejects the turn for lacking assistant prefill support.
