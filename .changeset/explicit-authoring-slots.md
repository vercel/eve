---
"eve": minor
---

Require static connections to use `defineMcpClientConnection` or `defineOpenAPIConnection` instead of plain object exports. Builds also reject `agent/sandbox.ts` beside `agent/sandbox/`; move the definition to `agent/sandbox/sandbox.ts`.
