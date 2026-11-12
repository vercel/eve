---
"eve": minor
---

Memory providers can define `recall["compaction.completed"]` to tell the model something after a compaction inside a long turn, such as where the compacted window was archived.

eve calls it once after each compaction that completes inside a turn, before the turn's next model call, with the compacted conversation. What it returns joins the turn's recall: a message with an `id` replaces the one recalled earlier with that `id`, and one without is added. A throwing handler fails the turn before the next model call. Providers without the handler still recall once per turn.

Thanks @zackleman for reporting this in #5923.
