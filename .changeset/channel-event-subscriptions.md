---
"eve": minor
---

Add channel subscriptions. A channel sets `subscriptions` in `defineChannel` with a `description`, an `inputSchema` and an `onEvent`, and calls `emit(event, input, { id, data })` from its routes for every occurrence. eve gives the model `subscribe`, `get_subscription` and `stop_subscription`, and delivers each occurrence to every session subscribed to that event name and input as a queued message under that session's saved auth, if `onEvent` returns a message or `true`. `githubChannel({ onEvent })` makes every GitHub webhook event subscribable by name (`check_suite.completed`, `issue_comment.created`), for a repository or one pull request. A webhook never opens a session; it only reaches sessions that subscribed.
