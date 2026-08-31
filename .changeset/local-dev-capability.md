---
"eve": patch
---

Adds `eve/local-dev`, whose `getLocalDevCapability()` gives authored code the
authored application root and a lease-based way to pause the authored-source
watcher while mutating that tree. The capability is scoped to same-machine
requests to `eve dev`; deployed runtimes and remote-attached clients receive
`undefined`.
