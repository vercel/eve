---
"eve": patch
---

A model run that a steering message cuts short now settles with `finishReason: "steered"` instead of `"other"`, and `model.settled` carries `steeredBy`, the delivery id of the steering message, when that delivery has an id. `steeredBy` is also on the run's row and observation. Protocol change: consumers that switch exhaustively on a run's `finishReason` see a new value, and consumers that matched `"other"` to detect a steered run should match `"steered"`.
