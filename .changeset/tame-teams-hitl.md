---
"eve": minor
---

Fix Microsoft Teams HITL cards to show tool arguments, use signed thread-stable continuation data, and handle message or invoke submissions through one shared activity authorization policy. Move Teams auth logic from `onMessage` to `authorizeActivity`; legacy unsigned cards now fail closed and must be recreated.
