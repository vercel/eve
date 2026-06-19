---
"eve": patch
---

Skip framework build cache directories (`.next`, `.nuxt`, and `.svelte-kit`) during development runtime source snapshot copying to prevent startup ENOENT crashes.
