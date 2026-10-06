---
"eve": patch
---

Chat SDK channels now deliver a sign-in to the person signing in when it starts in a shared thread, as a native ephemeral where the adapter supports one and otherwise as a direct message. The thread shows a link-free status in its place. Adapters that can do neither still post the existing "continue in a direct message" notice.
