---
"eve": patch
---

Give the local trace spool's on-disk layout a single owner: the shared trace reader now exposes the listing and segment-read primitives that `eve traces` and the `/traces` viewer both use, and payload formatting is shared between the detail panel and the conversation view.
