---
"eve": minor
---

Remove the disabled scaffold agent helper and the legacy root-tool registry setup handoff.

Old scaffold imports must migrate to `eve/extensions/self-modification/local`; the current local and remote extensions and the old-layout migration error remain unchanged.
