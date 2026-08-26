---
"eve": patch
---

Adds `eve/local-dev`, whose `getLocalDevCapability()` gives authored code the
authored application root and the ability to pause the authored-source
watcher while it mutates that tree — available only while a local `eve dev`
process owns the runtime, `undefined` everywhere else, including a TUI
attached to a remote `eve dev <url>`.
