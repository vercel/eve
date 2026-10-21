---
"eve": patch
---

The Discord Gateway relay can hand its session to the relay that replaces it, so messages sent during a deploy are no longer lost. Pass `handoff: vercelBlobHandoff()` to `experimental_runDiscordGatewayRelay` with a private Vercel Blob store connected, or any object with `take` and `put` methods.
