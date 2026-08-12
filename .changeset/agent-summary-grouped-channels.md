---
"eve": patch
---

The Vercel agent summary (`.eve/agent-summary.json`) now groups channels one entry per authored channel with routes nested under a `routes` array, instead of one flat entry per HTTP route. This is `schemaVersion` 4: a channel like `channels/eve.ts` reads as a single channel carrying its session, follow-up, and stream routes, so dashboards no longer over-count channels or repeat the same name per route.
