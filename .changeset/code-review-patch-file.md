---
"eve": patch
---

The `eve/extensions/code` review skill now writes the diff under review to a patch file in the shared sandbox and gives the worker its path, because the worker has no shell to run `git diff` itself. The worker's instructions no longer tell it to run commands.
