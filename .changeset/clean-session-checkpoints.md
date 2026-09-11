---
"eve": minor
---

Remove stream-backed session recovery and authorization callback URLs without attempt IDs. Sessions now require embedded checkpoints, with one inbox protocol and no wire negotiation or migration chain; start a new session when upgrading from the former execution model.
