---
"eve": patch
---

Sandbox work no longer delays the model call. Prewarmed sessions start the sandbox in the background, turns resume a sandbox the session already uses as they begin, and dynamic skill files are written in the background; a tool that uses the sandbox waits only for what remains. A first message sent to a prewarmed session no longer waits for prewarming, and its `defineSandbox()` selector runs with the auth of the request that created the session.
