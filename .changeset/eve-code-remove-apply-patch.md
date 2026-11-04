---
"eve": major
---

The code extension (`eve/extensions/code`) no longer mounts `code__apply_patch`; agents edit files with eve's default `edit_file` tool, and the `eve/extensions/code/tools` entry point is removed.

Import `grep` from `eve/tools/grep` instead of `eve/extensions/code/tools`. Move an override of the old tool, whether `agent/tools/code__apply_patch.ts` or `agent/extensions/code/tools/apply_patch.ts`, to `agent/tools/edit_file.ts` and spread `editFile` from `eve/tools/edit_file`. `edit_file` takes `path` and `edits` instead of a patch, so a wrapper that reads `input.patch` needs updating. A `code__apply_patch.ts` file that exports `disableTool()` fails `eve build` with `disables a slot with no lower-precedence source`; to keep agents from editing, export `disableTool()` from `agent/tools/edit_file.ts` instead.

`installCodeTooling()` no longer installs TypeScript or the post-edit diagnostics worker, and `CODE_TOOLING_REVALIDATION_KEY` changed, so sandbox templates keyed on it rebuild once.
