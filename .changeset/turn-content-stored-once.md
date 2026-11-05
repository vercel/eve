---
"@vercel/agent-runs": patch
---

Store a turn's attributes once in its checkpoint. The turn's copy of the model input and output was also saved in the turn's data, which doubled that content in every checkpoint write and sent large prompts into the oversized-checkpoint fallback.
