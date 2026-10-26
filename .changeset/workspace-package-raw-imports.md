---
"eve": patch
---

Workspace packages bundled from TypeScript source can now import their own files with `?raw` and other relative asset imports. Before, `eve build` failed with "resolves outside package root" when an agent imported such a package. `?raw` now also works for `.json` files and files without an extension, such as a `Dockerfile`.
