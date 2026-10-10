---
"eve": patch
---

A custom channel's `fetchFile` can throw `attachmentError(message)` from `eve/channels` to tell the model why a file didn't arrive, such as a size limit, while the original error stays in operator logs. `fetchFile` now types the `session` it already receives, and a `deliver` hook that returns nothing now falls back to the default input instead of dropping the message, including on a channel whose only hook is `deliver`.
