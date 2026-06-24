---
"eve": patch
---

Remote `eve dev --url` now treats `/eve/v1/info` as best-effort inspection rather than a connection gate. Once authentication succeeds and the deployment is reachable, the session connects even when the agent info route is absent (confirmed via the public health route) or returns an unrecognized shape (e.g. a deployment built from an older eve). Inspection-only data is simply omitted from the header in that case, and the underlying parse failure now names the offending fields instead of an opaque message.
