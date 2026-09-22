---
"eve": patch
---

Serialize automatic sandbox dependency installations that share a package-manager root, preventing concurrent providers or workspace apps from racing on dependency files. Waiting installations recheck their own package and can proceed after another installation fails.
