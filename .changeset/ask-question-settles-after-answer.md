---
"eve": patch
---

Fix `ask_question` tool calls appearing to run forever in the dev TUI after the user answers. Resolved question requests now emit a successful `action.result` event (previously only denied tool approvals did), so consumers settle the call and its spinner clears once answered.
