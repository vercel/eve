---
"eve": patch
---

CLI telemetry can now flag runs where the Vercel CLI's selected team is a Vercel-internal team, so Vercel can exclude its own usage. eve sends only `true` or `false`, never the team ID.
