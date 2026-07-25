---
"eve": patch
---

The client's `session.stream()` accepts `endAtTail: true` for bounded catch-up reads: it consumes events from the cursor to the durable tail observed when the stream opens — surviving reconnects and still advancing the stored `streamIndex` — then returns instead of following the live stream. The HTTP stream route reports the durable tail as the `x-eve-stream-tail-index` response header when a request opts in with `includeTailIndex=1`, and channel-authoring `Session` objects gain `getStreamTailIndex()` for serving bounded reads from custom routes.
