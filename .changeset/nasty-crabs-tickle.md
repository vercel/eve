---
"eve": patch
---

Fix `input.requested` replay erasing a prior HITL `inputResponse` (#1507)

When the event stream replays `input.requested` (e.g. after a resume), the reducer previously rebuilt the tool part from scratch with `state: "approval-requested"`, discarding any stored `eve.inputResponse` metadata written by `client.input.responded`. This left the UI showing an unanswered approval prompt even though the user had already responded.

The reducer now partitions on the existing tool-part state: if it's already `approval-responded`, preserve the prior `approval` and `toolMetadata` verbatim; otherwise emit a fresh `approval-requested` part with merged tool metadata. Includes a regression test covering the replay-after-respond flow.
