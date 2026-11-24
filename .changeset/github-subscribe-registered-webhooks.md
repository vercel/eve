---
"eve": patch
---

Reject a GitHub event subscription when the GitHub App does not receive the event's webhook.

`eve__subscribe` on the GitHub channel now reads the webhook events the App is set up to receive, with the installation token or the App key, and fails with an error naming the missing webhook instead of creating a subscription that never hears anything. A failed read also rejects the subscription, with GitHub's own status and message.
