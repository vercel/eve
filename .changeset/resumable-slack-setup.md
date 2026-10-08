---
"eve": minor
---

`eve add channel/slack` now resumes interrupted setup, reopens workspace installation for existing connectors, fixes stale routes without detaching, and avoids sharing a Slack app with another project or creating one with a taken name. The `eve/setup` Slack provisioning API now takes a connector selection from `inspectSlackbotConnectors` rather than inspecting a second time; a failed Vercel create reports its original error instead of a misleading cleanup failure.
