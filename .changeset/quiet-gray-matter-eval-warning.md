---
"eve": patch
---

eve no longer prints bundler warnings that come only from dependency code when it bundles authored modules, development generations, and workflow code, matching the production server build. Warnings from your own code and unresolved imports still print, and an unresolved import inside a workflow dependency still fails the build.
