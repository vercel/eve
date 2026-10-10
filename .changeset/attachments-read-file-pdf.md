---
"eve": patch
---

`read_file` now shows PDFs up to 20 MiB to the model as files, so the agent can reopen an attached PDF after compaction, or read one that a tool or `bash` wrote to the sandbox. Its output's `image` field is now `file` and carries `pages` for PDFs. `read_file` also refuses images over 8000 pixels per side, which providers reject.
