---
"eve": patch
---

HTTP channels can now opt into browser CORS with preflight handling. Use `defineChannel({ cors })` for custom channels or `eveChannel({ cors: true | options })` for the eve channel; omitted CORS remains disabled.
