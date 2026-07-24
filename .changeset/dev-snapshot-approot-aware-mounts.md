---
"eve": patch
---

`eve dev` no longer fails at boot with `UNRESOLVED_IMPORT` when a mounted extension (or any dependency) resolves through a `node_modules` above the app root — npm/yarn workspace hoisting, intermediate monorepo levels, and bare `withEve` agent directories whose host app owns the install now materialize in the dev-runtime snapshot.
