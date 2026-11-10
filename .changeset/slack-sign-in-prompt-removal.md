---
"eve": patch
---

After a Connect click, Slack swaps the private sign-in prompt for a line saying it waits on the sign-in, and removes that line once the sign-in ends.

Slack deletes an ephemeral message only through the `response_url` of a click on it, so the Connect click records that URL in the session's channel state under the sign-in's interaction id. Whichever of the click and the sign-in's ending reaches the session second posts `delete_original` to it, best effort. Channel code can make the same kind of change with the new `patchState()` on `ctx.from(address)`, which applies a JSON merge patch (RFC 7386) to a session's channel state without running a turn; an owner on an older eve version refuses it.
