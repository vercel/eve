---
"eve": patch
---

`githubChannel({ botName })` now also accepts a lazy resolver function, resolved on first use inside request handling, cached on success, and retried after a failure, so resolvers that depend on request-scoped credentials work in production. When `botName` is omitted, the channel falls back to the new `appSlug` field on `GitHubChannelCredentials`, then to `GITHUB_APP_SLUG`.
