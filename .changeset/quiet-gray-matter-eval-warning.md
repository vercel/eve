---
"eve": patch
---

eve no longer prints bundler warnings that come only from dependency code when it bundles authored modules, development generations, and workflow code, matching the production server build. Warnings from your own code still print, unresolved imports now print even when a dependency raises them (including in the production server build), and an unresolved import inside a workflow dependency still fails the build.
