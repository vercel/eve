---
"eve": patch
---

Hosted builds bundle faster: eve no longer re-parses its largest output chunk while adding the Node ESM compatibility banner, and Nitro no longer gzips every output file just to annotate the build log. The repeated `MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME` warning also no longer appears in build logs.
