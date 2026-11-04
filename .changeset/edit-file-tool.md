---
"eve": minor
---

Add the opt-in `edit_file` tool, exported from `eve/tools/edit_file`, which edits one sandbox file with exact text replacements matched the same way as pi's `edit` tool.

It is not a default tool: the code extension mounts it as `code__edit_file`, and `eve add tool/edit_file` adds it to other agents. The model sends `path` and a list of `{ oldText, newText }` edits, each matched once against the original file, with a fallback that ignores trailing whitespace and normalizes smart quotes, dashes, and special spaces. Files that are not valid UTF-8 are rejected rather than rewritten.

Thanks @badlogic for pi, whose MIT-licensed `edit` tool `edit_file` adapts.
