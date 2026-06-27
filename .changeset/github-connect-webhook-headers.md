---
"eve": patch
---

The GitHub channel now accepts Vercel Connect-forwarded webhook payloads that omit `x-github-event` and `x-github-delivery` by inferring the supported event type from the payload shape. Headerless forwarded payloads now emit a warning with the inferred metadata instead of being silently acknowledged and ignored.
