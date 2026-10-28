---
"eve": patch
---

Slack channels can add each sender's name and email to model-visible message metadata with the new `senderProfiles` option.

Model-visible Slack messages now group sender fields in a `<sender>` block (`type`, `id`, and with `senderProfiles`, `name` and `email`) instead of top-level `sender_type` and `sender_id` lines. Update any instructions or evals that match the old field names.
