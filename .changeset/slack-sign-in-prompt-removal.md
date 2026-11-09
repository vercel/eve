---
"eve": patch
---

Clicking Connect on the Slack sign-in prompt now replaces the prompt with a "Waiting for …" line instead of deleting it, and Slack deletes that line once the sign-in ends.

Slack changes an ephemeral message only through the `response_url` of a click on it, so the Connect click posts `replace_original` to that URL and records it in the session's channel state while the turn waits on the sign-in. The sign-in's `interaction.settled` handler posts `delete_original` to it, best effort. Channel code can make the same kind of change with the new `patchState()` on `ctx.from(address)`, which shallow-merges a JSON patch into a session's channel state without running a turn; an owner on an older eve version refuses it.
