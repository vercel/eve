---
"eve": major
---

Every agent now gets a default `edit_file` tool, the code extension drops `code__apply_patch`, and `bash` results and eve's system prompt now match pi's.

`edit_file`, exported from `eve/tools/edit_file`, edits one sandbox file with exact text replacements matched the same way as pi's `edit` tool. The model sends `path` and a list of `{ oldText, newText }` edits, each matched once against the original file, with a fallback that ignores trailing whitespace and normalizes smart quotes, dashes, and special spaces. Files that are not valid UTF-8 are rejected rather than rewritten, and a file keeps its mode, such as its executable bit, on sandboxes that write files with a default mode. Remove it with `defaultTools: false` or an `agent/tools/edit_file.ts` that exports `disableTool()`; an authored `agent/tools/edit_file.ts` replaces it.

`edit_file` changes existing files without `write_file`. If you disabled or wrapped `write_file` to limit writes, or gate `write_file` in an approval policy, do the same for `edit_file`. `write_file` can also overwrite a file the session read and then changed with `edit_file`, without another `read_file` call. A change made by anything else since the read still requires one.

The code extension (`eve/extensions/code`) no longer mounts `code__apply_patch`, and the `eve/extensions/code/tools` entry point is removed. Import `grep` from `eve/tools/grep` instead of `eve/extensions/code/tools`. Move an override of the old tool, whether `agent/tools/code__apply_patch.ts` or `agent/extensions/code/tools/apply_patch.ts`, to `agent/tools/edit_file.ts` and spread `editFile` from `eve/tools/edit_file`. `edit_file` takes `path` and `edits` instead of a patch, so a wrapper that reads `input.patch` needs updating. A `code__apply_patch.ts` file that exports `disableTool()` fails `eve build` with `disables a slot with no lower-precedence source`; to keep agents from editing, export `disableTool()` from `agent/tools/edit_file.ts` instead.

`installCodeTooling()` no longer installs TypeScript or the post-edit diagnostics worker, and `CODE_TOOLING_REVALIDATION_KEY` changed, so sandbox templates keyed on it rebuild once.

The code extension adds the workspace root's `AGENTS.md`, or `CLAUDE.md` when there is none, to the conversation, and its coding instructions now follow pi's tool guidance. The extension reads the file once per session, with one sandbox command on the first turn, which starts the sandbox. A file over 64,000 bytes is cut off with a note that tells the model where to read the rest.

A successful `bash` command shows only its output, or `(no output)`, and a command that exits non-zero ends with `[exit code: N]` and reaches the model as an error result. `bash` waits 60 seconds by default before it leaves a command running in the background, and a truncated `stdout` or `stderr` now names a file in the sandbox that holds its full output.

`toolOutput.errorText(value)` from `eve/tools`, or a `{ type: "error-text", value }` literal, lets any tool's `toModelOutput` show the model a failure while the call still completes, so channels and hooks get the full output on `call.settled`. The MCP channel returns such a result as its text with `isError: true`.

eve no longer adds a "Tool execution" note about parallel tool calls to every agent's system prompt. Tool calls in one response still run in parallel. Without the note, Sonnet 5.5 solved a concurrency task in 93% of replayed eve-code runs instead of 75%, matching how pi, which runs tool calls in parallel without telling the model, performs.

Thanks @badlogic for pi, whose MIT-licensed `edit` tool `edit_file` adapts.
