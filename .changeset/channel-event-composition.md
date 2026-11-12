---
"eve": minor
---

Built-in channel `events` accept `beforeDefault()`, `afterDefault()`, and `replaceDefault()` handlers, and `githubChannel({ handlers })` fans each webhook out to contributed `defineGitHubHandlers()` hooks.

Adding a handler no longer drops the channel's reply, failure, or checkout behavior; a plain handler still replaces the default and logs a warning. GitHub contributors run in list order with per-handler error isolation, and at most one starts a turn.
