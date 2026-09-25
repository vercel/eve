---
"eve": patch
---

Run parent stream-event hooks after publishing proxied input requests, authorization events, and their completion/waiting events. Hooks receive the parent context and the published event ID, while pending requests remain available for a response.
