---
"eve": patch
---

Pressing a human-in-the-loop button whose session is no longer active, for example after its run was cancelled outside eve, now retires the prompt the same way on Slack, Teams, Telegram, Discord, and Chat SDK: its buttons are replaced with `No longer active`, as a resolved prompt reads, and the person who pressed is told to send a new message: privately on Slack, Discord, Chat SDK and Telegram, and on Teams by the retired card itself, or the reply to an invoke. Before, the press was only logged (or, on Chat SDK, thrown) and the prompt stayed live.
