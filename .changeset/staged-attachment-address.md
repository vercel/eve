---
"eve": patch
---

A staged attachment whose bytes no longer match the address they were staged under is no longer sent to the model. Code in the sandbox can overwrite `/workspace/.eve/attachments/<sha>/<name>`; hydration now compares the bytes read back with the ref's size and SHA-256 prefix, and on a mismatch the model gets the same `FileNotFound` note as for a missing file.
