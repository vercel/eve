---
"eve": patch
---

Slack channels can add each sender's display name, real name, and email to model-visible message metadata with the new `messageContext.users` option.

`users: true` adds names, and `users: { email: true }` adds emails too. The triggering author's profile is also written to `message.author` and the default Slack auth attributes. Pass `resolve(user, next)` to own caching around eve's `users.info` lookup.
