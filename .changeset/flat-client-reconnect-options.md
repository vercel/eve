---
"eve": minor
---

Flatten client stream retry settings into `reconnect?: false | ReconnectOptions`.

Replace `streamReconnectPolicy: { reconnect: false }` with `reconnect: false`, move `streamOpenReconnectPolicy` fields under `reconnect`, and rename `retryableErrorStatuses` to `retryableStatuses`. The `StreamReconnectPolicy` and `StreamReconnectRetryPolicy` types are removed in favor of `ReconnectOptions`.
