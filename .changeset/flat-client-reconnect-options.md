---
"eve": minor
---

Flatten client stream retry settings into `reconnect?: false | ReconnectOptions`. Replace `streamReconnectPolicy: { reconnect: false }` with `reconnect: false`; move `streamOpenReconnectPolicy` fields directly under `reconnect`, and rename `retryableErrorStatuses` to `retryableStatuses`.
