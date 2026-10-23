---
"eve": patch
---

A model call that the provider rejects because of an image, such as one over a size limit, no longer ends the turn. eve retries the step once with images shown as their sandbox paths and a note explaining why, so the agent can continue.
