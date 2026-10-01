---
"eve": patch
---

Tools and connections that share one Vercel Connect connector now ask the user to sign in once. Before, each tool that called `ctx.getToken(connect(...))` and each connection using the same connector posted its own sign-in prompt for the same grant.
