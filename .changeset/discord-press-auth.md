---
"eve": patch
---

Discord button presses, selects, and modal submissions now answer as the Discord user who made them instead of anonymously, so requester-only and other approval response policies work on Discord. The new `onInputResponse` option on `discordChannel` chooses an answer's auth or drops it, and its context carries the presser's `defaultAuth`. Apps with a custom `onCommand` must also set `onInputResponse`; until they do, eve drops presses and logs a warning.
