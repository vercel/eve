---
"eve": patch
---

Slack channels can add each sender's name and email to model-visible message metadata with the new `senderProfiles` option.

Model-visible Slack messages now group their metadata into `<sender>` (`type`, `id`, and with `senderProfiles`, `name` and `email`), `<bot>` (`id`, `mentioned`), and `<thread>` (`team_id`, `channel_id`, `thread_ts`, `message_ts`) blocks instead of top-level lines such as `sender_id`, `bot_user_id`, and `is_mentioned`. Update any instructions or evals that match the old field names.
