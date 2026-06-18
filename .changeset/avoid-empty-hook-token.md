---
"eve": patch
---

Avoid creating workflow park hooks with an empty continuation token. Sessions that start without a token now wait until the first turn anchors one before registering the park hook.
