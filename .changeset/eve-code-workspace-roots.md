---
"eve": patch
---

`grep` and `apply_patch` in `eve/extensions/code` now work in sandboxes whose workspace is not `/workspace`, such as `/app`. `apply_patch` no longer requires a git checkout: `root` is optional and defaults to the workspace root, and outside git it still reports whitespace problems the patch introduced. It also accepts unified-diff range headers such as `@@ -118,8 +118,8 @@ def second():`, using the function context to pick between identical blocks.
