---
"eve": patch
---

Each `gh` tool refusal now names the offending token and its fix, and the tool description states the command rules. The tool also refuses a NUL character, an unquoted newline, a backslash-newline line continuation, and authenticated git that does not name `origin` right after the subcommand, which `main` accepted but could not run as written.
