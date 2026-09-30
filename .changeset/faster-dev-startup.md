---
"eve": patch
---

`eve dev` now reaches a ready server about 40% sooner. The bundled self-modification extension no longer re-bundles eve's internals for each module it loads, and dev builds no longer re-parse large output chunks. Installing eve also no longer reports `npm audit` advisories for `undici`, which is now 8.10.2.
