---
"eve": patch
---

Create conversation sessions before their first turn through the eve HTTP channel, TypeScript client, eval drivers, and frontend bindings so applications can move durable session startup off the first-message path.

Frontend bindings support opt-in `prewarm: true`, keep consuming the session stream across turns, and retry a starting inbox without waiting for stream events. Session initialization runs with the first message's identity and context.
