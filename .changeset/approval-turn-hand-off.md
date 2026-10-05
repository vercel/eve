---
"eve": patch
---

When someone other than the person whose turn asked for an approval answers it, that turn now ends with `turn.completed` and the approved call runs in a new turn for the responder. Before, the approved call and the rest of the original turn ran with the responder's identity while still counting as the original person's turn.
