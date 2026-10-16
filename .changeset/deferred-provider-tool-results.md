---
"eve": patch
---

Anthropic agents no longer fail with a 400 when the model calls a server tool, such as `web_search` or programmatic `code_execution`, beside a local tool. Anthropic runs that server tool after the local results arrive and returns its result at the start of the next response. eve now keeps the next request ending on those local results: a steering message waits for the deferred result, changed catalog or skill announcements wait a step, an empty-response retry sends its note as a system instruction, and compaction keeps the deferred result with its call and adds no resumption message after them.
