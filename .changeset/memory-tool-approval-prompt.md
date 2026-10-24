---
"eve": patch
---

Memory provider tools now support `approval.prompt`. Before, a provider tool with an approval prompt failed durable callback validation, so eve logged an error and dropped every tool from that memory slot for the turn.
