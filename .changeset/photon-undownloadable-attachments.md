---
"eve": patch
---

iMessage voice notes now reach Photon agents. Photon's webhook leaves out a voice note's attachment id, so eve refetches the message by id to download it. A file eve still can't download reaches the agent as a short note instead of being dropped without a reply.
