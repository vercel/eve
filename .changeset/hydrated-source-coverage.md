---
"eve": patch
---

Preserve source-line coverage when hydrating converted v26 history, so trailing records that produced no facts no longer move the store's published cursor or resume position backward. Saved reader metadata retains that coverage without adding placeholder facts or trusting another reader's cursor.
