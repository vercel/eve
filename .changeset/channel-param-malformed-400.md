---
"eve": patch
---

Channel routes now answer `400 Malformed request path.` when a path parameter has a malformed percent escape such as `%ZZ`, instead of throwing an uncaught `URIError` that surfaced as a generic 500.
