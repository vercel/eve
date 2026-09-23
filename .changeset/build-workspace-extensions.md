---
"eve": patch
---

`eve build` and `withEve` during `next build` now build mounted, source-backed workspace extensions before compiling the agent, as `eve dev` already does. Production builds no longer fail when a package manager skips the extension's `prepare` script, such as on a no-op install with a restored `node_modules` cache. An extension whose distribution is already current is not rebuilt, and a failed extension build names the package and the command to run.
