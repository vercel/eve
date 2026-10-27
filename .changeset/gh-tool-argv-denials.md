---
"eve": patch
---

The `gh` tool accepts backticks inside double quotes, braces such as `{owner}`, parentheses, and a `$` that cannot expand, and each refusal names the offending token, its fix, and an internal reason code. It now refuses an unquoted newline and a NUL character, joins backslash-newline continuations, and keeps a backslash inside double quotes unless bash removes it, so `"C:\path"` passes `C:\path`.
