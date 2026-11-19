---
"eve": minor
---

Add channel event subscriptions. A channel declares `subscriptions` in `defineChannel`, calls `publish` from its routes, and eve gives the model a subscribe tool per event plus `get_event_subscription` and `stop_event_subscription`. Each occurrence reaches the subscribing session as a queued message under the subscriber's saved auth. `githubChannel` offers `checks_finished` and `pr_comment` for a pull request.
