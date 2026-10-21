---
"eve": patch
---

A dynamic skill that stops returning `files` but is still returned now keeps the files already written to the sandbox, so files the sandbox provides another way, such as from its snapshot, stay in place. If you dropped `files` to take files away from some callers, stop returning the skill for them instead: a skill the resolver stops returning still has its files removed. On Vercel Sandbox, eve now writes a dynamic skill's files in one batch, with one path lookup and one upload instead of two round trips per file.
