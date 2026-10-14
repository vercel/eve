---
"eve": patch
---

Pass `followIdle: false` to `useEveAgent()` (React, Vue, and Svelte) or `EveAgentStore` to close the session stream while the session is idle instead of reconnecting it indefinitely. The stream reopens from its cursor on the next send, answer, or resume, and a prewarmed session opens no stream until its first message.
