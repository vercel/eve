---
"eve": patch
---

Fix compaction emitting a prompt that ends on an assistant turn, which providers without assistant-prefill support (e.g. Anthropic) reject with "the conversation must end with a user message". The trailing-assistant guard now runs against the fully-assembled compacted prompt instead of only the recent window, so it also covers the case where the recent window is empty (a single oversized turn, or `keep` decaying to 0) and the summary block itself is the final message.
