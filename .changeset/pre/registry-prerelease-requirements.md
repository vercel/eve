---
"eve": patch
---

`eve add` now installs a registry item on an eve prerelease, such as `1.0.0-rc.0`, when that version meets the item's minimum eve version.

Previously no prerelease satisfied a requirement such as `>=0.62.0`, so every item that declared one failed with "This registry item requires eve".
