---
"eve": patch
---

`chatSdkChannel` now reports failed final reply delivery with an error-id notice and a note to the model, avoids reposting streamed replies, and skips unchanged final edits after state restoration. Thanks @diegojohnsonl for reporting this in #4801.
