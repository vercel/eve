---
"eve": patch
---

The eve HTTP channel now enables permissive browser CORS by default, including preflight handling for session routes. Custom channels can opt into CORS with `defineChannel({ cors })`, and `eveChannel({ cors })` can disable or narrow the default policy.
