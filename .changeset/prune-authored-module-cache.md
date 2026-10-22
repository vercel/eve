---
"eve": patch
---

Compiles now prune `node_modules/.cache/eve/authored-modules` in the background, deleting cached bundles that no running eve process can still import, so the directory no longer grows without bound locally or in persisted Vercel build caches. Thanks @ryantbrown for reporting this in #847 and @kevludwig for reporting the Vercel build-cache impact.
