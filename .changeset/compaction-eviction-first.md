---
"eve": patch
---

Compaction now feeds the summarizer full-fidelity conversation text (tool payloads stay compact) and first tries evicting older tool results before summarizing; the kept recent window retains tool results verbatim. Agents lose less context per compaction and stop re-running completed tools.
