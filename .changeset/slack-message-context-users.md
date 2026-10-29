---
"eve": patch
---

Slack channels can add each sender's display name, real name, and email to model-visible message metadata with the new `messageContext.users` option.

`users: true` adds names, `users: { email: true }` adds emails too, and `users: { name: false, email: true }` adds emails only. The triggering author's profile is also written to `message.author` and the default Slack auth attributes. Pass `resolve(user, next)` to own caching around eve's `users.info` lookup.

Slack message metadata is now grouped into `<sender>`, `<bot>`, and `<thread>` blocks. `sender_type` and `sender_id` become `type` and `id` inside `<sender>`, `bot_user_id` and `is_mentioned` become `id` and `mentioned` inside `<bot>`, and the team, channel, and timestamp fields move into `<thread>`.
