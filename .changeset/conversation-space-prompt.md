---
"eve": minor
---

Tell the model what kind of place its conversation happens in, such as a private channel or a DM, from the channel's reported `ctx.conversation.space`.

When a channel reports a space, eve adds a short system note with its `type` and `visibility` (`unknown` when the platform didn't say), never its ID. Agents on channels that report no space see no change.
