---
"eve": patch
---

`eve dev --agent <name>` in an agent workspace now uses the model connection saved by `/login`.

Previously the dev host looked for it under the member directory, so a Vercel account sign-in failed every model call with "The model connection is unavailable". Thanks @cnaccio for reporting this in #5505.
