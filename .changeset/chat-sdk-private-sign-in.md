---
"eve": patch
---

Chat SDK channels now send a sign-in started in a shared thread to the person signing in, as an ephemeral message or a direct message, and show a link-free status in the thread. Adapters that support neither still post the existing "continue in a direct message" notice.
