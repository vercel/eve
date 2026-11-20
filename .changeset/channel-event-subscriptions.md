---
"eve": minor
---

Add durable event subscriptions for channels and unify subscription tools across channels and MCP connections.

- Custom channels can define `experimental.subscriptions.onEvent` on `defineChannel` to let sessions subscribe, and call `experimental.subscriptions.emit(event, input, { id, data })` from route handlers. `onEvent` returns a message or `null`. `onSubscribe` can deny a subscription by throwing, or narrow its scope. The types are exported from `eve/experimental/channels`.
- The root agent now uses one `eve__subscribe`, `eve__subscription_get`, and `eve__subscription_stop` tool set for both channels and MCP `experimental.events` connections, replacing per-connection `events_get_subscription` and `events_unsubscribe` tools and hiding `events_subscribe_<hash>` behind `eve__subscribe`. Subagents do not get these tools.
- `githubChannel({ experimental: { subscriptions: { onEvent } } })` enables subscriptions to GitHub webhook events per repository or pull request, with `onEvent` filtering and formatting each delivery. Pass `onComment: () => null` if you also want to disable default `@mention` comment sessions.
