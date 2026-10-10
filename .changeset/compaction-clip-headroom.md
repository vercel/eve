---
"eve": patch
---

Context compaction now accepts tool-output truncation only when the result fits under 60% of the compaction threshold. Before, eve accepted a truncation that landed just under the threshold, so compaction ran again a few steps later and the prompt cache was lost on each run. When truncation cannot get below 60%, eve now summarizes the conversation in the same pass.
