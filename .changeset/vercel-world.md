---
"eve": minor
---

`eve/experimental/embed` exports `vercelWorld()`, which keeps embedded sessions in a Vercel project's World, so a session continues on another machine.

Outside a deployment it uses the project `vercel link` linked the working directory to (or `projectId` and `teamId`), a token from `token`, `VERCEL_TOKEN` or the Vercel CLI's login, and the `preview` environment by default. The session still runs in the process that opened it.
