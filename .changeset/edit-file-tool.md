---
"eve": minor
---

Every agent now gets a default `edit_file` tool, exported from `eve/tools/edit_file`, which edits one sandbox file with exact text replacements matched the same way as pi's `edit` tool.

The model sends `path` and a list of `{ oldText, newText }` edits, each matched once against the original file, with a fallback that ignores trailing whitespace and normalizes smart quotes, dashes, and special spaces. Files that are not valid UTF-8 are rejected rather than rewritten. Remove it with `defaultTools: false` or an `agent/tools/edit_file.ts` that exports `disableTool()`; an authored `agent/tools/edit_file.ts` replaces it.

Thanks @badlogic for pi, whose MIT-licensed `edit` tool `edit_file` adapts.
