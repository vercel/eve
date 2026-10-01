---
"eve": patch
---

The Slack task card now shows how long each task took, as in `Done in 1m 14s: Found three incidents.` or `Failed after 3m`, and the finished plan title includes the turn's total time. A plan whose tasks are all subagent or remote agent calls names them, as in `Asking researcher and reviewer` or `Waiting on reviewer · 1 of 2 tasks done`. The card also keeps one `block_id` for the whole turn, so rows a reader expanded can stay open as the card updates. When a turn you keep messaging starts new tasks after its earlier ones settled, eve marks the earlier card finished and posts a new card instead of updating the old one further up the thread.
