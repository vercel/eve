---
"eve": minor
---

A dynamic schedule's `run` no longer starts its sessions again when the provider retries an occurrence.

A `to().send()` without an `idempotencyKey` now takes one from the occurrence and the message, so the retry reaches the session the first attempt started. Before, each retry started another session unless `run` passed its own key. A message that differs between attempts still starts another session; pass an `idempotencyKey` to keep it to one.
