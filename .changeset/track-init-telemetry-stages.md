---
"eve": patch
---

Record the furthest stage reached by `eve init`, `eve extension init`, and the interactive `eve dev --onboard` handoff in CLI telemetry, so failed setup runs can be grouped by their stage. Telemetry now also identifies whether its installation and project identifiers are ephemeral or persisted locally.
