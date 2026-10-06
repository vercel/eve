---
"eve": patch
---

Photon iMessage now passes files people send to the agent. eve downloads each attachment from Photon by its id, since the webhook carries no bytes; a failed download reaches the agent as a short note instead of being dropped.
