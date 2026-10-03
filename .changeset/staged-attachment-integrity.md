---
"eve": patch
---

Staged attachments are now checked against their content address before each model call. If code in the sandbox overwrote a staged file, the model gets a `FileNotFound` note instead of the replaced bytes posing as the original upload.
