---
"eve": minor
---

Add durable event subscriptions for channels and unify subscription tools across channels and MCP connections.

- Custom channels can define `onEvent` on `defineChannel` to let sessions subscribe, and call `emit(event, input, { id, data })` from route handlers.
- The model now uses one `subscribe`, `get_subscription`, and `stop_subscription` tool set for both channels and MCP `experimental.events` connections, replacing per-connection `events_get_subscription` and `events_unsubscribe` tools and hiding `events_subscribe_<hash>` behind `subscribe`.
- `githubChannel({ onEvent })` enables subscriptions to GitHub webhook events per repository or pull request, with `onEvent` filtering and formatting each delivery. Pass `onComment: () => null` if you also want to disable default `@mention` comment sessions.
