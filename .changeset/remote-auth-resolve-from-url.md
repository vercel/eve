---
"eve": patch
---

In remote sessions, `/vc:login` resolves the target Vercel project and owning team from the deployment URL. When the target requires authentication and Vercel cannot resolve its host in the active scope, the flow asks you to select another team, then reruns the lookup in that scope. When access is denied, for example because a team SSO session expired, it re-authenticates and retries.
