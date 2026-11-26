---
"eve": minor
---

Export `MAX_MESSAGE_PARTS` from `eve/channels/eve` and `eve/client` so clients can cap attachments at the eve channel's 64-part message limit without hard-coding it.

Thanks @muratsu for reporting this in #6650.
