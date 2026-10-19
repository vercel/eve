---
"eve": patch
---

iMessage voice notes now reach Photon agents. Photon's webhook leaves out a voice note's attachment id, so eve refetches the message by id to download it. Across Chat SDK channels, an attachment the platform gives no way to download now reaches the agent as a short note instead of being dropped, so an attachment-only message still gets a reply.
