---
"eve": patch
---

Allow empty-response recovery to use tools needed by the current request, including fresh reads, instead of treating earlier tool results as sufficient. The recovery instruction still asks the model to reuse suitable results, avoid repeating completed writes, and check uncertain action outcomes before retrying.
