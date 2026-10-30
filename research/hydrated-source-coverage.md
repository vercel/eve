---
issue: "https://github.com/vercel/eve/pull/5307"
status: implemented
last_updated: "2026-10-23"
---

# Hydrated source coverage

## Reader contract

`meta.position` identifies a materialized event at its original source line and fact index. Those coordinates alone cannot describe trailing source lines that emitted no events. A reader that consumed them can attach `meta.next` to the last event of a complete line: the exclusive end of its known source coverage. Persist that metadata with the events; applications do not maintain another cursor or add placeholder facts.

```text
source 0..6 -> 11 facts, last fact remains on source line 6
source    7 -> no facts, last fact's meta.next = 8
                         conversation/source cursor = 8
```

`convertLegacyEvents(records)` supplies this evidence when trailing records emit nothing. The existing `initialEvents` / `initialSession` constructor remains valid after JSON persistence. An old converted log without this metadata cannot recover the missing coverage from its facts; reconvert its original archive.

## Conversation and store behavior

`ConversationClient.hydrate` validates the reader metadata and calls the existing `Conversation.advancePosition` only after the event's complete line has folded. This is the same primitive #5307 uses for empty source lines in child observations. `position(view)` already means consumed source coverage, not the maximum materialized fact position. The store's existing snapshot and resume paths use it unchanged: no second cursor, maximum with a handle cursor, or extra reset state.

Coverage must be a safe integer past the annotated complete source line. Coverage on an unfinished line, or a later materialized event inside a range already covered, is rejected. As with facts themselves, callers must supply the ordered prefix as read, not forge or edit reader metadata.

A partial line is not acknowledged. Coverage from preceding complete lines survives partial hydration, detach, transport rollback, and resume. Reset already clears the conversation and its position. An independently advanced `initialSession` or shared handle cannot extend what this conversation has read. Stored fact coordinates, server authorization, execution, and line formats do not change.

## Scope and proof

The regression first fails with eight saved v26 records, 11 facts, and cursor 7 instead of 8. It verifies source position and published cursor 8, the actual resume GET's `startIndex=8`, JSON persistence, detach/reopen, and a following partial native commit. Native history, run-ahead handles, invalid coverage, contradictory prefixes, and reset are negative controls at the same owner boundary.

Trailing position markers on root live streams and `ClientSession.snapshot()` still under-claim when they produce no events. This patch does not promote a transport tail header or another reader's cursor as evidence, or redesign those read APIs. The existing advancement primitive remains available for that separate propagation follow-up.
