---
"eve": patch
---

Workflow and step modules can now embed files from `node_modules` with relative asset imports.

Before, `eve build` failed with `UNLOADABLE_DEPENDENCY` for an import such as `../node_modules/pkg/README.md?raw`, even though the same import worked in a tool. Thanks @mikestevenson-aries for reporting this in #5847.
