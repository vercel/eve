---
"eve": patch
---

A custom channel's `fetchFile` can throw `attachmentError(message)` from `eve/channels` to tell the model why a file didn't arrive, such as a size limit, while the original error stays in operator logs. `fetchFile` now types the `session` it already receives, and `eve/channels` exports the `FetchFileFunction`, `FetchFileContext`, and `FetchFileResult` types for resolvers written in their own module.
