---
"eve": patch
---

Take only the code channel owner's answer to a question or budget prompt eve posts in a Slack code channel.

Slack admits the origin conversation's members to a code channel, and all of them see the buttons on a card eve posts there, so any member could settle a question meant for one person — including a confirm prompt an agent asks the owner before acting on someone else's message. eve now records the channel's owner (the person it opened the channel for, or whoever started the session in a channel eve adopted) and refuses an answer from anyone else, telling them in an ephemeral message whose request it is while the card stays up.

Tool approvals are unchanged: who may approve stays with the tool's approval policy, its requester by default. Direct-message cards and cards eve rendered before it knew the owner are also unchanged.
