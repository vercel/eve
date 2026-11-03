---
"eve": major
---

The code extension (`eve/extensions/code`) no longer mounts `code__apply_patch`, and `eve/extensions/code/tools` no longer exports `apply_patch`.

To give the model a file-editing tool, run `eve add tool/edit_file`, which writes `agent/tools/edit_file.ts` re-exporting `eve/tools/edit_file`. Delete any `agent/tools/code__apply_patch.ts` file: an override that imports `apply_patch` no longer resolves, and one that exports `disableTool()` fails `eve build` with `disables a slot with no lower-precedence source`.

`installCodeTooling()` no longer installs TypeScript or the post-edit diagnostics worker, and `CODE_TOOLING_REVALIDATION_KEY` changed, so sandbox templates keyed on it rebuild once.
