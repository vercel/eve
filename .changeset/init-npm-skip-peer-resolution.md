---
"eve": patch
---

Make `eve init` install a fresh npm project faster by skipping npm's optional peer dependency lookups, which downloaded hundreds of megabytes of package metadata without installing anything.
