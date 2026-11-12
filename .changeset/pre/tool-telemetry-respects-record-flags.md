---
"eve": patch
---

AI SDK telemetry integrations no longer receive tool arguments, results, or raw errors for a call whose `recordInputs` or `recordOutputs` setting is off.

eve runs agent tools itself, so the AI SDK does not filter their telemetry events. eve now removes the excluded content before it calls each integration, the same way the AI SDK filters the events it sends. Integrations that ignore the per-call settings, such as Sentry's eve integration, previously recorded tool arguments for private conversations.
