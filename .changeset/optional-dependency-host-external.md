---
"eve": patch
---

Keep packages host-external in server builds when they only reference a `build.externalDependencies` entry through `optionalDependencies` or an optional `peerDependenciesMeta` peer.

Thanks @kachar for reporting this and providing the minimal reproduction in #6554.
