---
"eve": minor
---

Extension distributions now record the eve version they were built with and a distribution generation instead of per-capability epochs. Extensions built with the old epoch-based manifest must be rebuilt with this release and republished; eve rejects old manifests with rebuild guidance before loading extension code.
