---
"eve": patch
---

Slack `thread.post` no longer returns a file id in the `id` field. A `{ text, files }` post previously returned the uploaded file's id where every other variant returns the message `ts`, so a caller following the documented contract and calling `chat.update` with it got `message_not_found`. That post form goes through `files.completeUploadExternal`, which returns no message `ts`, so `id` is now empty for it. Slack file ids are available on the new `fileIds` field, which every `post` variant returns.
