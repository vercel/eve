---
"eve": patch
---

Add experimental schedule collections with caller-scoped create, list, and delete tools and an explicit `runAs: "creator" | "app"` execution policy. Occurrences preserve creation context without stored credentials and run channel-less; an optional experimental Slack action uses captured installation context to send directly to the requester, origin thread, or app-authorized channels without a fixed workspace setting.
