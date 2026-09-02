---
"eve": patch
---

fix(client): skip replayed message.appended / message.completed when the step's text run is already done (#1507)

`upsertRun` previously appended a fresh part whenever the latest same-step run was `done`, so a stale resume-stream cursor replaying past events could duplicate a completed text part for the same `stepIndex`. The reducer now checks: if the incoming snapshot's text is a prefix of the last done run's recorded text (including exact equality), the upsert is declined as a replay. New turns producing different text for the same step continue to append a new part (`text → tool call → more text` multi-run pattern, unchanged).

Complements the prior partial fix in the same stream (#1507 input-requested preservation already shipped separately); together the reducer is idempotent against both replay classes the issue identifies.

Includes regression coverage in `message-reducer.test.ts` driving `message.appended("Hel") → message.appended("Hello") → message.completed("Hello")` twice and asserting a single done part survives; plus a control test asserting different text on the same step still appends a new run.
