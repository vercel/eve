---
"eve": patch
---

eve no longer prints bundler warnings raised only by dependency code, such as the direct `eval` warning from the vendored gray-matter parser, when it bundles authored modules, development generations, and workflow code; the production server build already hid them. Warnings from your own code are still printed, and an unresolved import inside a workflow dependency still fails the build.
