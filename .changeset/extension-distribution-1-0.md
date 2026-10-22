---
"eve": minor
---

Extension distributions now record the eve version they were built with and a distribution generation instead of per-capability epochs. Existing pre-1.0 distributions must be rebuilt with eve 1.0 and republished; eve rejects old manifests with a rebuild instruction before loading extension code.
