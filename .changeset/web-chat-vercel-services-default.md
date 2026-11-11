---
"eve": patch
---

`eve add channel/web` no longer asks how to host Web Chat: it always deploys the app and agents as Vercel services.

Rerunning the installer keeps an app that an earlier release set up to embed the agent. To run the generated app outside Vercel, embed the agent in it as described in the Next.js and TanStack Start guides. The `web-hosting` answer is no longer read.
