---
"eve": patch
---

Keep a turn's input in history when a dynamic definition fails before the model call.

A dynamic skill, tool, or other value that threw before the first model call failed the turn without saving the user's message, so a later "try again" reached the model without the original request. The message now joins history before the turn fails, as it does when the model call itself fails.
