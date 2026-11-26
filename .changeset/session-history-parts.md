---
"eve": minor
---

Session `history` entries can carry ordered `parts` with text and completed tool exchanges, so sessions and local evals can start from conversations that used tools.

Supply either `text` (unchanged shorthand) or `parts` (`{ type: "text", text }` and `{ type: "tool", name, input?, output | error }`) on `SessionHistoryMessage`. Consecutive tool parts lower into parallel calls and results in order without running tools, hooks, or `call.*` events, and frontend `EveMessage` renders them as completed or failed tool parts. `delivery.consumed` keeps `text` populated alongside the new `parts` field (`ImportedPart`, `ImportedTextPart`, `ImportedToolPart` from `eve/events`).

Thanks @FranciscoMoretti for the request and prototype in #5340, and @matchai for the eval tool-history proposal in #6855.
