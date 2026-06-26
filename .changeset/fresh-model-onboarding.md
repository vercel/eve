---
"eve": patch
---

Fresh agents now start model setup from their prefilled `/model` prompt, installing the Vercel CLI and logging in when those prerequisites are missing. Other `eve dev` sessions leave missing model setup as an attention prompt.
