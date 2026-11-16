---
"eve": patch
---

Stop a turn's model call as soon as a cancel or steering message arrives under `eve dev`, instead of letting the call finish and its tools run first.

The `eve dev` worker now follows the local Workflow World's live event feed through the CLI parent, so a running step hears of a cancel or a steer right away instead of at the runtime's next log poll, every 2 seconds or more. `eve start` gets the same fix from the local World itself.

Thanks @karthikjn01 for reporting this in #6481.
