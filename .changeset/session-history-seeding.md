---
"eve": patch
---

Channel `send()`, channel message hooks, and a new `create()` on channel addresses accept `history` to add prior user and assistant messages, such as a stored transcript, as real turns. `create()` starts a session that waits for its first message and reports with `created` whether it did. A new `history.imported` stream event publishes added messages; the default client reducer renders them, and `transcriptReducer()` includes them. Slack `threadContext` now adds earlier replies as history when a message starts the thread's session; later messages keep the existing transcript.
