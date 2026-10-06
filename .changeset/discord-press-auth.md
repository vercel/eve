---
"eve": patch
---

Discord button presses, selects, and modal submissions now answer as the Discord user who made them instead of anonymously, so approval response policies such as requester-only approvals work on Discord. The new `onInputResponse` option on `discordChannel` lets you choose an answer's auth or drop it, as `onCommand` does for commands.
