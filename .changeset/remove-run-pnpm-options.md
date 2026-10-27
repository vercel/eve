---
"eve": patch
---

Remove the deprecated internal setup type alias `RunPnpmOptions`. Setup tooling should use `RunPackageManagerOptions`; package-manager command behavior is unchanged.
