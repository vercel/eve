---
"eve": patch
---

Extensions installed with a registry-style store layout (e.g. from npm with pnpm) now work in `eve dev` and `eve eval`. Extension modules reached through a node_modules symlink resolve their dependencies from the package's real location — matching standard resolver semantics — instead of failing with `UNRESOLVED_IMPORT`/`ERR_MODULE_NOT_FOUND` or silently picking up another copy of the dependency from the consuming app.
