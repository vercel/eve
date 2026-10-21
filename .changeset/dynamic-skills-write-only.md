---
"eve": patch
---

A dynamic skill that stops returning `files` but is still returned no longer has its files deleted from the sandbox, so files the sandbox provides another way, such as from its snapshot, stay in place. A skill the resolver stops returning still has its files removed. On Vercel Sandbox, eve now writes a dynamic skill's files in one batch, with one path lookup and one upload instead of two round trips per file.
