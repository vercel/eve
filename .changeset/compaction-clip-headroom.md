---
"eve": patch
---

Context compaction now accepts a compacted history only when it fits under 60% of the compaction threshold, measured the same way the trigger measures it (fixed prompt envelope included). Before, a tool-output truncation that landed just under the threshold, or a summary plus recent tail that fit only without the prompt envelope, was accepted and compaction ran again a few steps later, rewriting the prompt prefix and losing the prompt cache each time. When truncation cannot reach the limit, eve summarizes in the same pass; if even the bare summary does not fit, compaction fails instead of returning a history that is over the limit.
