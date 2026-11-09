---
"eve": patch
---

Sessions that switch models between turns now decide whether to compact using the new model's own token count, so compaction runs before the turn starts instead of between its steps.

Different models' tokenizers can count the same history very differently. eve judged each call by the token count the previous call reported, so after switching to a model whose tokenizer counts higher, the history could cross the compaction threshold during the turn's first step and be rewritten before the next step, invalidating the prompt cache a second time in one turn. eve now keeps each model's latest measurement of the history and uses the step's own model's count when it has one.
