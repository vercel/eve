---
"eve": minor
---

Add channel subscriptions. A channel lists the events a session may subscribe to in `defineChannel`'s `subscriptions`, each with a `description`, an `inputSchema` and an optional `onEvent`, and calls `emit(event, input, { id, data })` from its routes. eve gives the model `subscribe`, `get_subscription` and `stop_subscription`, and delivers each occurrence to every session subscribed with the same input as a queued message under that session's saved auth. `githubChannel({ subscriptions: { checks_finished: true, pr_comment: true } })` makes those two events on a pull request subscribable.
