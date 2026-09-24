---
"eve": patch
---

Stop exposing the deployment's `x-vercel-protection-bypass` secret in `authorization.required` events. The event's `webhookUrl` no longer carries the query parameter; the callback URL the runtime hands to connection strategies still does, so protected deployments keep receiving callbacks.
