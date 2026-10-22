---
"eve": patch
---

`eve dev` now rebuilds once per edit to a source-backed workspace extension. Before, the temporary `.eve-extension-build-*` files from the extension build started a second, unnecessary rebuild.
