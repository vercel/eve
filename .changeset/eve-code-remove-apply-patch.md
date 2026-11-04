---
"eve": major
---

The code extension (`eve/extensions/code`) mounts eve's built-in `edit_file` tool as `code__edit_file` in place of `code__apply_patch`, and `eve/extensions/code/tools` no longer exports `apply_patch`.

Rename an `agent/tools/code__apply_patch.ts` override to `agent/tools/code__edit_file.ts` and spread `editFile` from `eve/tools/edit_file` instead of `apply_patch`. A `code__apply_patch.ts` file that exports `disableTool()` fails `eve build` with `disables a slot with no lower-precedence source`; rename it to `code__edit_file.ts` to keep the extension's editing tool off.

`installCodeTooling()` no longer installs TypeScript or the post-edit diagnostics worker, and `CODE_TOOLING_REVALIDATION_KEY` changed, so sandbox templates keyed on it rebuild once.
