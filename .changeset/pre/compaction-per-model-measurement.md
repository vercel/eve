---
"eve": patch
---

Sessions that switch back to a model now check its retained token measurement as well as the latest measurement, reducing compaction between steps.

Different models' tokenizers can count the same history very differently. eve judged each call by the token count the previous call reported, so after switching to a model whose tokenizer counts higher, the history could cross the compaction threshold during the turn's first step and be rewritten before the next step, invalidating the prompt cache a second time in one turn. eve now keeps each model's latest measurement until history is rewritten. Before each call, eve uses the larger count after estimating additions from both the selected model's measurement and the latest measurement. A model without a retained measurement still falls back to the latest one.
