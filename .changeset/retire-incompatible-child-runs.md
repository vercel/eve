---
"eve": patch
---

On worlds without per-deployment routing, incompatible subagent sessions and workflow tool runs (including tasks) are now cancelled when their queue deliveries arrive, instead of attempting replay on the new eve version. Top-level sessions remain available for replacement or reset, and session timeout workflows continue to run.
