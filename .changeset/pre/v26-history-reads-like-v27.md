---
"eve": patch
---

Sessions recorded before eve 1.0 now read the way a current eve records them, and opening a subagent's stream through such a parent no longer re-reads the parent's whole history on every open and reconnect, which could make long sessions answer 404 `descendant_unavailable`.

eve now verifies the child against only the parent's stored line at the requested position, whichever eve version wrote it.

A question or approval that a subagent relayed before eve 1.0 now reads as a current relayed request: it names the task it came from when there is one, and carries the subagent's session, request, and the call it asks about. A relayed approval no longer reads as an approval of the parent's own subagent call.

Turns recorded before eve 1.0 now keep their trace context when read: each converted `turn.started` carries the `trace` its stored line recorded, as a turn a current eve runs does. A malformed recorded trace reads as absent instead of failing the line's schema.

Thanks @zackleman for reporting these in #5928, #5933, and #5934.
