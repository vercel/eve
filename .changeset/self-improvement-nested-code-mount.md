---
"eve": patch
"@eve/self-improvement": patch
---

Fix `eve build` for an app that imports `eve/extensions/code/sandbox` and also mounts `@eve/self-improvement`.

The self-improvement maintainer mounts its own `code` extension, so the build rejected the app's `installCodeTooling` import as belonging to two mounts. An app import now binds to the app's mount and skips mounts nested inside another extension. The coordinator's `step` tool input is now an object with an `action` enum instead of a root-level union, which Claude rejects.
