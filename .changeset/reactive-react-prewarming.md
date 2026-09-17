---
"eve": patch
---

Allow React `useEveAgent` to observe `prewarm` across renders so interfaces can prepare a session when the user starts composing. Reset uses the latest rendered value, while disabling prewarming does not discard a session already starting or created.
