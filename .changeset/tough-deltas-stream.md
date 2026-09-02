---
"eve": minor
---

Store message and reasoning stream appends as offset-addressed deltas instead of repeating cumulative text. Raw stream consumers can use `appendStreamTextDelta` from `eve/client` to reconstruct contiguous text.
