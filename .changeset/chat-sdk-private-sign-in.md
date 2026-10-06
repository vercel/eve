---
"eve": patch
---

Chat SDK channels can now deliver a sign-in privately when it starts outside a direct message, as a native ephemeral where the adapter supports one and otherwise as a direct message, with a link-free status in the thread. This needs per-person `auth` and the handler's `Thread` passed to `send`; otherwise, including with the default `auth: null`, the thread still gets the "continue in a direct message" notice.
