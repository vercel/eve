---
"eve": minor
---

Instructions now accept `content` with an optional `system` or `user` role, and dynamic instruction resolvers have a lifecycle-specific typed API. User-role instructions enter durable conversation history at their static, session, or turn boundary; the legacy `markdown` form remains available as a deprecated system-role definition.
