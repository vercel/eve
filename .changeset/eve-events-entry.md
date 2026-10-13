---
"eve": patch
---

A new `eve/events` entry exports the v27 event catalog, the fold every client and server reader shares, selectors over its tables, and guards for hooks and channels. `foldReceivedEvent(view, event)` updates a view one event at a time, and `copyView(view)` copies one cheaply.
