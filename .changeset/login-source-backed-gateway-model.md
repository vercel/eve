---
"eve": patch
---

`/login` now works for agents whose `model` is a gateway SDK call such as `gateway("anthropic/claude-sonnet-5")`. In `eve dev`, a gateway-routed model instance is served through the connection saved by `/login` (Vercel account, AI Gateway key, or project), the same way a string model id is, and `/login` no longer tries to rewrite `agent.ts` for it. Previously the failed source edit sent you back to the connection picker after every sign-in.
