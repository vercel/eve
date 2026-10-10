---
"eve": patch
---

Fix a second, never-settling `web_search` part under AI Gateway. eve no longer streams input for provider tools such as `web_search`, so each search shows up once, under the call id it runs and settles with.
