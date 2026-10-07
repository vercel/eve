---
"eve": patch
---

Schedule subscriptions default to Vercel Schedules in production and process-local storage under `eve dev`, so an explicit `provider` is no longer required. Pass a provider to override the backend, or use `vercelScheduleProvider` from `eve/experimental/schedules/vercel` to customize the Vercel endpoint.
