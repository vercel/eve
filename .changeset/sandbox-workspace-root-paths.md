---
"eve": patch
---

Custom sandbox providers can declare `workspaceRoot` on a connection, and eve resolves relative paths, the default working directory, `resolvePath(".")`, and build-time workspace seeding from it; built-in providers keep `/workspace`. The `read_file`, `write_file`, `glob`, and `grep` tools now accept paths relative to the workspace root, and the workspace and skills prompt sections no longer name `/workspace`.
