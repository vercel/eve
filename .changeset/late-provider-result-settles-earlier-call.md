---
"eve": patch
---

A provider tool result that arrives in the response after its call, such as an Anthropic tool search the model started beside a local tool, now settles the call the earlier step introduced.

Previously eve published that call a second time, so with the session-event checker on (`eve dev`, `eve eval`, or `EVE_CHECK_SESSION_EVENTS=1`) the step failed with `introduced-twice`, and without it the session log recorded one call introduced twice.
