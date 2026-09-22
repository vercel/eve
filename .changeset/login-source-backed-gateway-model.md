---
"eve": patch
---

`/login` now works for agents whose `model` is a raw AI SDK instance instead of a string or eve helper. In `eve dev`, `gateway("...")` is served through the saved Vercel, AI Gateway key, or project connection, and `@ai-sdk/openai` responses or `@ai-sdk/anthropic` messages instances are served through the matching saved API key, the same way a string id or `openai()`/`anthropic()` already are. `/login` no longer tries to rewrite `agent.ts` for these; previously the failed edit sent you back to the connection picker after every sign-in.
