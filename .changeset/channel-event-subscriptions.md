---
"eve": minor
---

Add channel subscriptions. A channel declares `subscriptions` with `onSubscribe`, `onUnsubscribe` and `onEvent` in `defineChannel` and calls `emit` from its routes. eve gives the model `subscribe`, `get_subscription` and `stop_subscription`, and delivers each occurrence to every subscribing session as a queued message under that session's saved auth. `githubChannel` offers `checks_finished` and `pr_comment` for a pull request.
