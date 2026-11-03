---
"eve": minor
---

Add `errorCode` to `defineTool` so a tool can report a returned result as failed with a bounded code that traces record as `error.type`, while the model still reads the full result.

The git extension's `gh` tool uses it: a command that fails, such as a rejected `git push`, now settles as failed with a code like `non-fast-forward`, `protected-branch`, or `permission-denied`. Nonzero exits that answer a question, such as `git diff --exit-code` or pending `gh pr checks`, still complete.
