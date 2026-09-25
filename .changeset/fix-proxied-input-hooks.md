---
"eve": patch
---

Run parent stream-event hooks after publishing proxied input requests, authorization events, and their completion/waiting events. Hooks receive the parent context and published event ID, and response routes are persisted before publication so a failing hook cannot discard them.
