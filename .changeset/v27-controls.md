---
"eve": patch
---

`Session`, channel addresses, and channel sources accept `{ auth }` to name who sent a `cancel`, `clear`, `compact`, or `reset`, and the HTTP control routes pass the caller's auth.
